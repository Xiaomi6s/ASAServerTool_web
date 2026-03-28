const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const pidusage = require('pidusage');
const Rcon = require('srcds-rcon');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// 固定的服务端安装路径，位于项目根目录下的 ASA_Server 文件夹
const INSTALL_DIR_NAME = 'ASA_Server';
const DEFAULT_INSTALL_PATH = path.join(process.cwd(), INSTALL_DIR_NAME);

const configPath = path.join(process.cwd(), 'config.json');
let serverProcess = null;
let updateProcess = null;
let serverStatus = 'stopped'; // 'stopped', 'starting', 'running', 'updating'

// 尝试监听端口的函数，如果被占用则自动加 1
function startServer(port) {
    server.listen(port, () => {
        console.log(`=================================================`);
        console.log(`ARK: ASA Web Server Tool is running!`);
        console.log(`Please open your browser and visit:`);
        console.log(`http://localhost:${port}`);
        console.log(`=================================================`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${port} is in use, trying port ${port + 1}...`);
            startServer(port + 1);
        } else {
            console.error(err);
        }
    });
}

// 默认从 3000 开始尝试
startServer(3000);

// WebSocket connections
let clients = [];
wss.on('connection', (ws) => {
    clients.push(ws);
    ws.send(JSON.stringify({ type: 'log', message: 'WebSocket 连接成功，已连接到控制台。' }));
    ws.send(JSON.stringify({ type: 'status', status: serverStatus }));
    
    ws.on('close', () => {
        clients = clients.filter(c => c !== ws);
    });
});

function broadcastLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const formattedMessage = `[${timestamp}] ${message}`;
    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'log', message: formattedMessage }));
        }
    });
    // Optional: write to file
}

function broadcastStatus(status) {
    serverStatus = status;
    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'status', status: serverStatus }));
        }
    });
}

// 下载 SteamCMD 辅助函数
function downloadSteamCmd(destDir) {
    return new Promise((resolve, reject) => {
        const zipUrl = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
        const zipPath = path.join(destDir, 'steamcmd.zip');
        
        broadcastLog(`正在从 ${zipUrl} 下载 SteamCMD...`);
        
        const file = fs.createWriteStream(zipPath);
        https.get(zipUrl, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`下载失败，状态码: ${response.statusCode}`));
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                broadcastLog('SteamCMD 下载完成，正在解压...');
                try {
                    const zip = new AdmZip(zipPath);
                    zip.extractAllTo(destDir, true);
                    broadcastLog('解压完成！');
                    fs.unlinkSync(zipPath); // 删除压缩包
                    resolve();
                } catch (err) {
                    reject(new Error(`解压失败: ${err.message}`));
                }
            });
        }).on('error', (err) => {
            fs.unlinkSync(zipPath);
            reject(err);
        });
    });
}

// 辅助函数：更新 INI 文件
function updateIniFile(filePath, section, updates) {
    if (!fs.existsSync(filePath)) {
        // 如果文件不存在，先创建所在的目录
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, '', 'utf8');
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let lines = content.split(/\r?\n/);
    let inSection = false;
    let sectionFound = false;
    let sectionStartIndex = -1;
    let sectionEndIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith('[') && line.endsWith(']')) {
            if (line === `[${section}]`) {
                inSection = true;
                sectionFound = true;
                sectionStartIndex = i;
            } else if (inSection) {
                sectionEndIndex = i;
                break;
            }
        }
    }

    if (inSection && sectionEndIndex === -1) {
        sectionEndIndex = lines.length;
    }

    if (!sectionFound) {
        lines.push('');
        lines.push(`[${section}]`);
        for (const [key, value] of Object.entries(updates)) {
            lines.push(`${key}=${value}`);
        }
    } else {
        const sectionLines = lines.slice(sectionStartIndex + 1, sectionEndIndex);
        const newSectionLines = [];
        const handledKeys = new Set();

        for (let line of sectionLines) {
            let keyMatch = line.match(/^([^=]+)=/);
            if (keyMatch) {
                let key = keyMatch[1].trim();
                if (updates[key] !== undefined) {
                    newSectionLines.push(`${key}=${updates[key]}`);
                    handledKeys.add(key);
                } else {
                    newSectionLines.push(line);
                }
            } else {
                newSectionLines.push(line);
            }
        }

        for (const [key, value] of Object.entries(updates)) {
            if (!handledKeys.has(key)) {
                newSectionLines.push(`${key}=${value}`);
            }
        }

        lines.splice(sectionStartIndex + 1, sectionEndIndex - sectionStartIndex - 1, ...newSectionLines);
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

// API: 获取配置
app.get('/api/config', (req, res) => {
    try {
        const configData = fs.readFileSync(configPath, 'utf8');
        res.json(JSON.parse(configData));
    } catch (err) {
        res.status(500).json({ error: '无法读取配置文件' });
    }
});

// API: 保存配置
app.post('/api/config', (req, res) => {
    try {
        const newConfig = req.body;
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
        broadcastLog('配置已保存到本地。');
        res.json({ success: true, message: '配置已保存' });
    } catch (err) {
        res.status(500).json({ error: '保存配置文件失败' });
    }
});

// API: 启动服务器
app.post('/api/server/start', (req, res) => {
    if (serverProcess) {
        return res.status(400).json({ error: '服务器已在运行中' });
    }
    
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        broadcastStatus('starting');
        broadcastLog(`准备启动 ASA 服务器，地图: ${config.map}...`);
        
        const installPath = DEFAULT_INSTALL_PATH;
        
        // 写入 INI 配置文件
        const gameIniPath = path.join(installPath, 'ShooterGame\\Saved\\Config\\WindowsServer\\Game.ini');
        const gameUserSettingsIniPath = path.join(installPath, 'ShooterGame\\Saved\\Config\\WindowsServer\\GameUserSettings.ini');
        
        try {
            // 更新 Game.ini (主要针对倍率和高级参数)
            updateIniFile(gameIniPath, '/Script/ShooterGame.ShooterGameMode', {
                MatingIntervalMultiplier: config.matingInterval,
                MatingSpeedMultiplier: config.matingSpeed,
                EggHatchSpeedMultiplier: config.eggHatchSpeed,
                BabyMatureSpeedMultiplier: config.babyMatureSpeed,
                BabyImprintAmountMultiplier: config.babyImprintAmountMultiplier,
                BabyCuddleIntervalMultiplier: config.babyCuddleInterval,
                BabyImprintingStatScaleMultiplier: config.babyImprintingStatScale,
                BabyFoodConsumptionSpeedMultiplier: config.babyFoodConsumptionSpeed,
                BabyCuddleGracePeriodMultiplier: config.babyCuddleGracePeriod,
                BabyCuddleLoseImprintQualitySpeedMultiplier: config.babyCuddleLoseImprintQualitySpeed,
                bDisableStructurePlacementCollision: config.disableStructurePlacementCollision ? 'true' : 'false',
                bUseSingleplayerSettings: config.useSingleplayerSettings ? 'true' : 'false',
                PerPlatformMaxStructuresMultiplier: config.platformMaxStructuresMultiplier,
                MaxTamedDinos: config.maxTamedDinos,
                PlayerDamageMultiplier: config.playerDamage,
                PlayerResistanceMultiplier: config.playerResistance,
                PlayerCharacterWaterDrainMultiplier: config.playerWaterDrain,
                PlayerCharacterFoodDrainMultiplier: config.playerFoodDrain,
                PlayerCharacterStaminaDrainMultiplier: config.playerStaminaDrain,
                PlayerCharacterHealthRecoveryMultiplier: config.playerHealthRecovery,
                PlayerHarvestingDamageMultiplier: config.playerHarvestingDamage,
                DinoCountMultiplier: config.dinoCount,
                DinoDamageMultiplier: config.dinoDamage,
                DinoResistanceMultiplier: config.dinoResistance,
                DinoCharacterFoodDrainMultiplier: config.dinoFoodDrain,
                DinoCharacterStaminaDrainMultiplier: config.dinoStaminaDrain,
                DinoCharacterHealthRecoveryMultiplier: config.dinoHealthRecovery,
                DinoHarvestingDamageMultiplier: config.dinoHarvestingDamage,
                DinoTurretDamageMultiplier: config.dinoTurretDamage,
                DisableTame: config.disableTame ? 'true' : 'false',
                DisableDinoRiding: config.disableRiding ? 'true' : 'false',
                StructureDamageMultiplier: config.structureDamage,
                StructureResistanceMultiplier: config.structureResistance,
                bAllowSpeedLeveling: config.allowSpeedLeveling ? 'true' : 'false',
                bAllowFlyerSpeedLeveling: config.allowFlyerSpeedLeveling ? 'true' : 'false',
                bAllowUnlimitedRespecs: config.allowUnlimitedRespecs ? 'true' : 'false',
                PreventDownloadSurvivors: config.preventDownloadSurvivors ? 'true' : 'false',
                PreventDownloadDinos: config.preventDownloadDinos ? 'true' : 'false',
                PreventDownloadItems: config.preventDownloadItems ? 'true' : 'false',
                NoTributeDownloads: config.noTributeDownloads ? 'true' : 'false',
                bDisableFriendlyFire: config.disableFriendlyFire ? 'true' : 'false'
            });

            // 更新 GameUserSettings.ini (主要针对基础服务器设置和玩家环境设置)
            updateIniFile(gameUserSettingsIniPath, 'ServerSettings', {
                HarvestAmountMultiplier: config.harvestMultiplier,
                XPMultiplier: config.xpMultiplier,
                TamingSpeedMultiplier: config.tamingMultiplier,
                DifficultyOffset: config.difficultyOffset,
                MaximizeOfficialDifficulty: config.maximizeDifficulty ? 'True' : 'False',
                allowThirdPersonPlayer: config.allowThirdPerson ? 'True' : 'False',
                globalVoiceChat: config.globalVoiceChat ? 'True' : 'False',
                proximityChat: config.proximityChat ? 'True' : 'False',
                alwaysNotifyPlayerJoin: config.alwaysNotifyPlayerJoin ? 'True' : 'False',
                alwaysNotifyPlayerLeft: config.alwaysNotifyPlayerLeft ? 'True' : 'False',
                ServerAdminLog: config.serverAdminLog ? 'True' : 'False',
                ServerCrosshair: config.enableCrosshair ? 'True' : 'False',
                ShowMapPlayerLocation: config.showMapPlayerLocation ? 'True' : 'False',
                AllowFlyerCarryPvE: config.allowFlyerCarryPvE ? 'True' : 'False',
                DayTimeSpeedScale: config.dayTimeSpeed,
                NightTimeSpeedScale: config.nightTimeSpeed,
                ServerHardcore: config.hardcoreMode ? 'True' : 'False',
                ForceAllowCaveFlyers: config.forceAllowCaveFlyers ? 'True' : 'False',
                AutoSavePeriodMinutes: config.autoSavePeriod,
                ServerForceNoHUD: config.forceNoHUD ? 'True' : 'False',
                EnablePvPGamma: config.enablePvPGamma ? 'True' : 'False',
                ShowCreativeMode: config.showCreativeMode ? 'True' : 'False',
                DisableLootCrates: config.disableLootCrates ? 'True' : 'False'
            });
        } catch (iniErr) {
            broadcastLog(`[警告] 更新 INI 配置文件时出错: ${iniErr.message}`);
        }

        // 构造启动参数
        let args = [
            config.map + '?listen',
            `?SessionName=${config.serverName.replace(/ /g, '_')}`,
            `?MaxPlayers=${config.maxPlayers}`,
            `?Port=${config.port}`,
            `?QueryPort=${config.queryPort}`
        ];
        
        if (config.serverPassword) args.push(`?ServerPassword=${config.serverPassword}`);
        if (config.adminPassword) args.push(`?ServerAdminPassword=${config.adminPassword}`);
        if (config.enablePvE) args.push(`?ServerPVE=true`);
        if (config.enableRcon) args[0] += `?RCONEnabled=True?RCONPort=${config.rconPort || 27020}`;
        
        // 追加 Mod 和启动命令行参数 (-)
        if (config.mods) args.push(`-mods=${config.mods}`);
        if (config.noBattlEye) args.push(`-NoBattlEye`);
        if (config.autoManagedMods) args.push(`-automanagedmods`);
        if (config.forceAllowCaveFlyers) args.push(`-ForceAllowCaveFlyers`);
        
        // 附加自定义启动参数
        if (config.customArgs) {
            const customArgsArray = config.customArgs.split(' ').filter(a => a.trim() !== '');
            args = args.concat(customArgsArray);
        }

        // 附加活动事件
        if (config.activeEvent) {
            args.push(`-ActiveEvent=${config.activeEvent}`);
        }
        
        broadcastLog(`启动参数: ${args.join(' ')}`);

        const exePath = path.join(installPath, 'ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe');
        
        if (fs.existsSync(exePath)) {
            serverProcess = spawn(exePath, args, { cwd: installPath });
        } else {
            broadcastLog(`警告: 未在 ${exePath} 找到可执行文件，将以模拟模式启动（持续输出日志）。`);
            // 模拟进程，使用 Windows 自带的 ping 命令不断输出
            serverProcess = spawn('ping', ['127.0.0.1', '-t']);
        }

        broadcastStatus('running');
        broadcastLog('服务器进程已启动！');

        serverProcess.stdout.on('data', (data) => {
            broadcastLog(data.toString().trim());
        });

        serverProcess.stderr.on('data', (data) => {
            broadcastLog(`[ERROR] ${data.toString().trim()}`);
        });

        serverProcess.on('close', (code) => {
            serverProcess = null;
            broadcastStatus('stopped');
            broadcastLog(`服务器进程已退出，退出码: ${code}`);
        });
        
        res.json({ success: true, message: '启动命令已发送' });
    } catch (err) {
        broadcastStatus('stopped');
        res.status(500).json({ error: '启动服务器失败: ' + err.message });
    }
});

// API: 停止服务器
app.post('/api/server/stop', (req, res) => {
    if (!serverProcess) {
        return res.status(400).json({ error: '服务器未运行' });
    }
    
    broadcastLog('正在发送停止命令...');
    // 在 Windows 上，可能需要使用 taskkill 强制终止进程树
    spawn('taskkill', ['/pid', serverProcess.pid, '/f', '/t']);
    // serverProcess.kill();
    
    res.json({ success: true, message: '停止命令已发送' });
});

// API: 获取状态
app.get('/api/server/status', (req, res) => {
    res.json({ status: serverStatus });
});

// API: 下载或更新服务器
app.post('/api/server/update', async (req, res) => {
    if (serverProcess) {
        return res.status(400).json({ error: '请先停止服务器后再进行更新或安装' });
    }
    if (updateProcess) {
        return res.status(400).json({ error: '服务器正在更新/安装中，请稍候...' });
    }

    try {
        const installPath = DEFAULT_INSTALL_PATH;

        // 确保安装路径存在
        if (!fs.existsSync(installPath)) {
            fs.mkdirSync(installPath, { recursive: true });
        }

        broadcastStatus('updating');
        broadcastLog('----------------------------------------');
        broadcastLog(`开始下载/更新 ASA 服务端，目标路径: ${installPath}`);

        // ASA 服务端的 Steam App ID 是 2430930
        const appId = '2430930';
        
        // SteamCMD 目录 (放在与 exe 同级的目录下)
        const steamCmdDir = path.join(process.cwd(), 'steamcmd');
        const steamCmdExe = path.join(steamCmdDir, 'steamcmd.exe');

        if (!fs.existsSync(steamCmdDir)) {
            fs.mkdirSync(steamCmdDir, { recursive: true });
        }

        // 如果 steamcmd.exe 不存在，先下载
        if (!fs.existsSync(steamCmdExe)) {
            broadcastLog(`未找到 SteamCMD，准备自动下载...`);
            try {
                await downloadSteamCmd(steamCmdDir);
            } catch (err) {
                broadcastLog(`[错误] 下载 SteamCMD 失败: ${err.message}`);
                broadcastStatus('stopped');
                return res.status(500).json({ error: '下载 SteamCMD 失败' });
            }
        }

        broadcastLog('正在调用 SteamCMD...');
        const args = [
            '+force_install_dir', installPath,
            '+login', 'anonymous',
            '+app_update', appId, 'validate',
            '+quit'
        ];

        broadcastLog(`执行命令: steamcmd.exe ${args.join(' ')}`);

        // 将运行逻辑封装为函数，以便在 code 7 时自动重试
        function runSteamCmd(attempt = 1) {
            broadcastLog(`[第 ${attempt} 次尝试] 启动 SteamCMD 进程...`);
            updateProcess = spawn(steamCmdExe, args);

            updateProcess.stdout.on('data', (data) => {
                const msg = data.toString('utf8').trim();
                if (msg) broadcastLog(msg);
            });

            updateProcess.stderr.on('data', (data) => {
                const msg = data.toString('utf8').trim();
                if (msg) broadcastLog(`[更新错误] ${msg}`);
            });

            updateProcess.on('close', (code) => {
                updateProcess = null;
                
                // 退出码 7 表示 SteamCMD 自身刚刚完成更新并重启了自身，但这会导致 spawn 进程结束
                // 我们需要捕获这个情况并重新运行命令，以确保真正下载游戏服务端
                if (code === 7 && attempt < 3) {
                    broadcastLog(`[提示] SteamCMD 自身更新完毕 (退出码 7)。准备再次启动以继续下载服务端文件...`);
                    setTimeout(() => runSteamCmd(attempt + 1), 3000); // 延迟 3 秒重试
                } else {
                    broadcastStatus('stopped');
                    broadcastLog('----------------------------------------');
                    if (code === 0) {
                        broadcastLog(`更新/安装完成！(退出码: ${code})`);
                    } else if (code === 7) {
                        broadcastLog(`SteamCMD 更新完成，但达到了最大重试次数，请再次手动点击更新。`);
                    } else {
                        broadcastLog(`更新/安装可能遇到问题，退出码: ${code}`);
                    }
                }
            });
        }

        // 开始第一次运行
        runSteamCmd(1);

        res.json({ success: true, message: '更新进程已启动，请查看控制台日志。' });

    } catch (err) {
        broadcastStatus('stopped');
        res.status(500).json({ error: '更新失败: ' + err.message });
    }
});

// API: 检测服务器安装状态
app.get('/api/server/install-status', (req, res) => {
    try {
        const installPath = DEFAULT_INSTALL_PATH;
        const exePath = path.join(installPath, 'ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe');
        
        if (fs.existsSync(exePath)) {
            res.json({ installed: true, message: '服务器已安装' });
        } else {
            res.json({ installed: false, message: '未检测到服务器文件' });
        }
    } catch (err) {
        res.status(500).json({ error: '无法检测安装状态: ' + err.message });
    }
});

// API: 立即存档 (向服务器发送 SaveWorld 命令)
app.post('/api/server/save', async (req, res) => {
    if (!serverProcess || serverStatus !== 'running') {
        return res.status(400).json({ error: '服务器未运行，无法存档' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.enableRcon) {
            broadcastLog('----------------------------------------');
            broadcastLog('[系统提示] 触发了“立即存档”操作，但未开启 RCON。');
            broadcastLog('[系统提示] 请在游戏内使用管理员命令 `cheat SaveWorld` 存档，或在配置中开启 RCON。');
            broadcastLog('----------------------------------------');
            return res.json({ success: true, message: '未开启 RCON，仅记录操作' });
        }

        const rcon = Rcon({
            address: '127.0.0.1',
            password: config.adminPassword,
            port: config.rconPort || 27020
        });

        await rcon.connect();
        const response = await rcon.command('SaveWorld');
        rcon.disconnect();

        broadcastLog('----------------------------------------');
        broadcastLog(`[RCON] 发送存档命令成功: ${response}`);
        broadcastLog('----------------------------------------');

        res.json({ success: true, message: '已发送存档命令' });
    } catch (err) {
        broadcastLog(`[RCON Error] 存档失败: ${err.message}`);
        res.status(500).json({ error: 'RCON 命令发送失败: ' + err.message });
    }
});

// API: 备份存档
app.post('/api/server/backup', (req, res) => {
    try {
        const savedDir = path.join(DEFAULT_INSTALL_PATH, 'ShooterGame\\Saved');
        const backupDir = path.join(process.cwd(), 'backups');

        if (!fs.existsSync(savedDir)) {
            return res.status(400).json({ error: '未找到存档目录，请确认服务器是否已启动过。' });
        }

        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `backup_${timestamp}.zip`;
        const backupFilePath = path.join(backupDir, backupFileName);

        const output = fs.createWriteStream(backupFilePath);
        const archive = archiver('zip', {
            zlib: { level: 9 } // 最高压缩级别
        });

        output.on('close', function() {
            broadcastLog(`存档备份完成！文件名: ${backupFileName}，大小: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
        });

        archive.on('error', function(err) {
            throw err;
        });

        archive.pipe(output);
        archive.directory(savedDir, false);
        archive.finalize();

        broadcastLog(`开始备份存档，请稍候...`);
        res.json({ success: true, message: '备份任务已在后台启动。' });

    } catch (err) {
        res.status(500).json({ error: '备份失败: ' + err.message });
    }
});

// API: 获取备份列表
app.get('/api/server/backups', (req, res) => {
    try {
        const backupDir = path.join(process.cwd(), 'backups');
        if (!fs.existsSync(backupDir)) {
            return res.json({ backups: [] });
        }
        const files = fs.readdirSync(backupDir).filter(file => file.endsWith('.zip'));
        res.json({ backups: files });
    } catch (err) {
        res.status(500).json({ error: '获取备份列表失败: ' + err.message });
    }
});

// API: 恢复存档
app.post('/api/server/restore', (req, res) => {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: '未提供备份文件名' });

    if (serverProcess) {
        return res.status(400).json({ error: '请先停止服务器后再恢复存档！' });
    }

    try {
        const backupFilePath = path.join(process.cwd(), 'backups', file);
        const savedDir = path.join(DEFAULT_INSTALL_PATH, 'ShooterGame\\Saved');

        if (!fs.existsSync(backupFilePath)) {
            return res.status(404).json({ error: '备份文件不存在' });
        }

        broadcastLog(`准备恢复存档: ${file}...`);

        // 如果原有 Saved 目录存在，为了安全起见，我们将其重命名为 .old
        if (fs.existsSync(savedDir)) {
            const oldDir = `${savedDir}_old_${Date.now()}`;
            fs.renameSync(savedDir, oldDir);
            broadcastLog(`旧存档已备份至: ${oldDir}`);
        }

        // 解压备份文件到对应的位置
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(backupFilePath);
        
        broadcastLog('正在解压文件...');
        zip.extractAllTo(savedDir, true);
        
        broadcastLog('存档恢复成功！');
        res.json({ success: true, message: '存档恢复成功' });

    } catch (err) {
        broadcastLog(`[错误] 恢复存档失败: ${err.message}`);
        res.status(500).json({ error: '恢复存档失败: ' + err.message });
    }
});

// API: 获取服务器性能数据
app.get('/api/server/performance', (req, res) => {
    if (!serverProcess || serverStatus !== 'running') {
        return res.json({ cpu: 0, mem: 0 }); // 返回数字以便前端进度条处理
    }

    pidusage(serverProcess.pid, (err, stats) => {
        if (err) {
            return res.json({ cpu: 0, mem: 0 });
        }
        
        // stats.cpu: CPU 占用百分比
        // stats.memory: 内存占用 (Bytes)
        const cpuPercent = stats.cpu.toFixed(1);
        const memMB = (stats.memory / 1024 / 1024).toFixed(2);
        
        res.json({ cpu: Number(cpuPercent), mem: Number(memMB) });
    });
});

// API: 获取服务器外部 IP (简单实现)
app.get('/api/server/ip', async (req, res) => {
    try {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        let localIp = '127.0.0.1';
        
        // 查找第一个非环回的 IPv4 地址
        for (const devName in interfaces) {
            const iface = interfaces[devName];
            for (let i = 0; i < iface.length; i++) {
                const alias = iface[i];
                if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                    localIp = alias.address;
                    break;
                }
            }
            if (localIp !== '127.0.0.1') break;
        }
        
        res.json({ ip: localIp });
    } catch (err) {
        res.json({ ip: '127.0.0.1' });
    }
});

// API: 获取在线玩家数 (通过 RCON 查询)
app.get('/api/server/players', async (req, res) => {
    if (!serverProcess || serverStatus !== 'running') {
        return res.json({ success: false, players: 0 });
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.enableRcon) {
            return res.json({ success: false, players: 0, message: 'RCON 未开启' });
        }

        const rcon = Rcon({
            address: '127.0.0.1',
            password: config.adminPassword,
            port: config.rconPort || 27020
        });

        await rcon.connect();
        const response = await rcon.command('listplayers');
        rcon.disconnect();

        // 解析 listplayers 的返回结果
        // 返回格式通常是 "No Players Connected" 或者一行一个玩家信息
        if (response.includes('No Players Connected')) {
            return res.json({ success: true, players: 0 });
        } else {
            // 通过换行符分割，过滤掉空行，就是玩家数量
            const lines = response.trim().split('\n');
            // 确保不把表头或无关信息算进去，简单算行数即可（每行一个玩家）
            const playerCount = lines.filter(line => line.trim().length > 0 && !line.includes('No Players')).length;
            return res.json({ success: true, players: playerCount });
        }
    } catch (err) {
        // RCON 连接失败或超时
        res.json({ success: false, players: 0, error: err.message });
    }
});

// 删除旧的固定端口监听
// server.listen(3000, () => {
//     console.log('Server is running on port 3000');
// });