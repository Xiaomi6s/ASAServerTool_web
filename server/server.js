const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const pidusage = require('pidusage');
const { GameDig } = require('gamedig');
const RconClient = require('rcon');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const os = require('os');

// (已删除旧的 select-folder API，因为不再支持自定义备份目录)

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
let autoBackupTimer = null; // 自动备份定时器

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

// ARK/UE 常把 GameAnalytics、部分 Info 日志写到 stderr，并不等于进程错误
function formatServerStderrChunk(chunk) {
    const raw = String(chunk || '').replace(/\r\n/g, '\n');
    const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    return lines.map((line) => {
        if (/\bGameAnalytics\b/i.test(line) || /\bI\s+Info\//i.test(line) || /\bD\s+Debug\//i.test(line)) {
            return `[引擎] ${line}`;
        }
        if (/\bE\s+Error\//i.test(line) || /\bFatal\b/i.test(line) || /\bAssertion failed\b/i.test(line)) {
            return `[错误] ${line}`;
        }
        return `[stderr] ${line}`;
    }).join('\n');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 INI 读取某 section 下的 key（用于 config.json 未填管理员密码时回退） */
function readIniValue(filePath, sectionName, keyName) {
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    let inSection = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            inSection = trimmed === `[${sectionName}]`;
            continue;
        }
        if (!inSection) continue;
        const esc = keyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = line.match(new RegExp(`^\\s*${esc}\\s*=\\s*(.*)$`));
        if (m) {
            let v = m[1].trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
            }
            return v;
        }
    }
    return '';
}

function gameUserSettingsIniPath() {
    return path.join(DEFAULT_INSTALL_PATH, 'ShooterGame\\Saved\\Config\\WindowsServer\\GameUserSettings.ini');
}

/** RCON 使用的管理员密码：优先 config.json，空则读服务端 INI（与游戏内管理员密码一致） */
function resolveAdminPasswordForRcon(config) {
    let pwd = String(config.adminPassword || '').trim();
    if (pwd) return pwd;
    pwd = readIniValue(gameUserSettingsIniPath(), 'ServerSettings', 'ServerAdminPassword');
    return String(pwd || '').trim();
}

/** 与 cerious-aasm 的 prepareServerConfig 一致：无密码时生成 16 位随机串并写回 config.json */
function generateRandomPassword(length) {
    const n = length || 16;
    return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/**
 * 若 config.json 与 INI 均无管理员密码，则自动生成并保存（参考项目对 rconPassword 的处理）。
 * 返回已含可用密码的 config 对象。
 */
function ensureConfigHasAdminPassword() {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        throw new Error('无法读取 config.json');
    }
    if (resolveAdminPasswordForRcon(config)) {
        return config;
    }
    config.adminPassword = generateRandomPassword(16);
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        broadcastLog('[系统] 未设置管理员密码：已自动生成 16 位密码并写入 config.json（与 cerious-aasm 行为一致）。');
    } catch (e) {
        throw new Error('无法保存自动生成的管理员密码: ' + e.message);
    }
    return config;
}

// 与 cerious-aasm 一致使用 node-rcon（srcds-rcon 认证阶段仅 3s 超时，易导致失败）
function connectRconOnce(host, port, password, authTimeoutMs) {
    return new Promise((resolve, reject) => {
        const rcon = new RconClient(host, port, password);
        let settled = false;
        const failTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                rcon.disconnect();
            } catch (_) {}
            reject(new Error('RCON 认证超时（请确认服务端已完全启动，且 RCON 端口、管理员密码与启动参数一致）'));
        }, authTimeoutMs);

        const onAuth = () => {
            if (settled) return;
            settled = true;
            clearTimeout(failTimer);
            rcon.removeListener('error', onErr);
            resolve(rcon);
        };

        const onErr = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(failTimer);
            rcon.removeListener('auth', onAuth);
            try {
                rcon.disconnect();
            } catch (_) {}
            reject(err);
        };

        rcon.once('auth', onAuth);
        rcon.once('error', onErr);
        rcon.connect();
    });
}

function sendRconCommand(rcon, command, timeoutMs) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let debounceTimer = null;
        const maxTimer = setTimeout(() => {
            cleanup();
            resolve(parts.join('\n'));
        }, timeoutMs);

        function cleanup() {
            clearTimeout(maxTimer);
            if (debounceTimer) clearTimeout(debounceTimer);
            rcon.removeListener('response', onResp);
            rcon.removeListener('error', onErr);
        }

        const onResp = (str) => {
            if (str) parts.push(str);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                cleanup();
                resolve(parts.join('\n'));
            }, 450);
        };

        const onErr = (err) => {
            cleanup();
            reject(err);
        };

        rcon.on('response', onResp);
        rcon.once('error', onErr);
        rcon.send(command);
    });
}

async function executeRconCommand(command) {
    const config = ensureConfigHasAdminPassword();
    if (config.enableRcon === false) {
        throw new Error('RCON 未开启，请在配置中启用后重试');
    }

    const rconPort = parseInt(String(config.rconPort || 27020), 10);
    const adminPassword = resolveAdminPasswordForRcon(config);

    const maxAttempts = 25;
    const delayMs = 2000;
    let lastError = null;

    for (let i = 1; i <= maxAttempts; i++) {
        let rcon = null;
        try {
            if (i === 1 || i % 5 === 0 || i === maxAttempts) {
                broadcastLog(`[RCON] 连接 127.0.0.1:${rconPort}（第 ${i}/${maxAttempts} 次）…`);
            }
            rcon = await connectRconOnce('127.0.0.1', rconPort, adminPassword, 20000);
            const response = await sendRconCommand(rcon, command, 15000);
            try {
                rcon.disconnect();
            } catch (_) {}
            return response || '(无文本回复，命令可能已执行)';
        } catch (err) {
            lastError = err;
            if (rcon) {
                try {
                    rcon.disconnect();
                } catch (_) {}
            }
            if (i < maxAttempts) {
                await sleep(delayMs);
            }
        }
    }

    throw lastError || new Error('RCON 连接失败');
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
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!String(configData.adminPassword || '').trim()) {
            const fromIni = readIniValue(gameUserSettingsIniPath(), 'ServerSettings', 'ServerAdminPassword');
            if (fromIni) configData.adminPassword = fromIni;
        }
        if (configData.rconPort === undefined || configData.rconPort === null || configData.rconPort === '') {
            configData.rconPort = 27020;
        }
        res.json(configData);
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
        const config = ensureConfigHasAdminPassword();
        
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
                ServerAdminPassword: config.adminPassword,
                RCONEnabled: config.enableRcon !== false ? 'True' : 'False',
                RCONPort: config.rconPort || 27020,
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
                ShowFloatingDamageText: config.showFloatingDamageText ? 'True' : 'False',
                ShowCreativeMode: config.showCreativeMode ? 'True' : 'False',
                DisableLootCrates: config.disableLootCrates ? 'True' : 'False'
            });
        } catch (iniErr) {
            broadcastLog(`[警告] 更新 INI 配置文件时出错: ${iniErr.message}`);
        }

        // 构造启动参数 (参考 test7 优化)
        let mapString = config.map + '?listen';
        mapString += `?SessionName=${config.serverName.replace(/ /g, '_')}`;
        if (config.serverPassword) mapString += `?ServerPassword=${config.serverPassword}`;
        mapString += `?QueryPort=${config.queryPort || 27015}`;

        // 附加 test7 中经验证有效的 ? 参数
        // 倍率参数 (放入命令行比写ini更稳定)
        mapString += `?XPMultiplier=${config.xpMultiplier || 1.0}`;
        mapString += `?TamingSpeedMultiplier=${config.tamingMultiplier || 1.0}`;
        mapString += `?HarvestAmountMultiplier=${config.harvestMultiplier || 1.0}`;
        mapString += `?DifficultyOffset=${config.difficultyOffset || 1.0}`;
        mapString += `?OverrideOfficialDifficulty=${config.overrideOfficialDifficulty || 5.0}`;
        mapString += `?MatingIntervalMultiplier=${config.matingInterval || 1.0}`;
        mapString += `?EggHatchSpeedMultiplier=${config.eggHatchSpeed || 1.0}`;
        mapString += `?BabyMatureSpeedMultiplier=${config.babyMatureSpeed || 1.0}`;
        mapString += `?DinoCountMultiplier=${config.dinoCount || 1.0}`;
        
        mapString += `?BabyCuddleIntervalMultiplier=${config.babyCuddleInterval || 1.0}`;
        mapString += `?BabyCuddleGracePeriodMultiplier=${config.babyCuddleGracePeriod || 1.0}`;
        mapString += `?BabyCuddleLoseImprintQualitySpeedMultiplier=${config.babyCuddleLoseImprintQualitySpeed || 1.0}`;
        mapString += `?BabyImprintingStatScaleMultiplier=${config.babyImprintingStatScale || 1.0}`;
        mapString += `?BabyFoodConsumptionSpeedMultiplier=${config.babyFoodConsumptionSpeed || 1.0}`;

        mapString += `?PlayerCharacterWaterDrainMultiplier=${config.playerWaterDrain || 1.0}`;
        mapString += `?PlayerCharacterFoodDrainMultiplier=${config.playerFoodDrain || 1.0}`;
        mapString += `?PlayerCharacterStaminaDrainMultiplier=${config.playerStaminaDrain || 1.0}`;
        mapString += `?PlayerCharacterHealthRecoveryMultiplier=${config.playerHealthRecovery || 1.0}`;

        mapString += `?DinoCharacterFoodDrainMultiplier=${config.dinoFoodDrain || 1.0}`;
        mapString += `?DinoCharacterStaminaDrainMultiplier=${config.dinoStaminaDrain || 1.0}`;
        mapString += `?DinoCharacterHealthRecoveryMultiplier=${config.dinoHealthRecovery || 1.0}`;
        mapString += `?TamedDinoCharacterFoodDrainMultiplier=${config.tamedDinoFoodDrain || 1.0}`;
        mapString += `?TamedDinoTorporDrainMultiplier=${config.tamedDinoTorporDrain || 1.0}`;
        mapString += `?PassiveTameIntervalMultiplier=${config.passiveTameInterval || 1.0}`;

        mapString += `?DayTimeSpeedScale=${config.dayTimeSpeed || 1.0}`;
        mapString += `?NightTimeSpeedScale=${config.nightTimeSpeed || 1.0}`;
        mapString += `?DayCycleSpeedScale=${config.dayCycleSpeedScale || 1.0}`;
        
        mapString += `?ResourceNoReplenishRadiusPlayers=${config.resourceNoReplenishRadiusPlayers || 1.0}`;
        mapString += `?ResourcesRespawnPeriodMultiplier=${config.resourcesRespawnPeriodMultiplier || 1.0}`;
        mapString += `?CropGrowthSpeedMultiplier=${config.cropGrowthSpeedMultiplier || 1.0}`;
        mapString += `?CropDecaySpeedMultiplier=${config.cropDecaySpeedMultiplier || 1.0}`;
        mapString += `?PoopIntervalMultiplier=${config.poopIntervalMultiplier || 1.0}`;
        mapString += `?LayEggIntervalMultiplier=${config.layEggIntervalMultiplier || 1.0}`;
        mapString += `?GlobalSpoilingTimeMultiplier=${config.globalSpoilingTimeMultiplier || 1.0}`;
        mapString += `?GlobalItemDecompositionTimeMultiplier=${config.globalItemDecompositionTimeMultiplier || 1.0}`;
        mapString += `?GlobalCorpseDecompositionTimeMultiplier=${config.globalCorpseDecompositionTimeMultiplier || 1.0}`;
        mapString += `?ItemStackSizeMultiplier=${config.itemStackSizeMultiplier || 1.0}`;
        mapString += `?FuelConsumptionIntervalMultiplier=${config.fuelConsumptionIntervalMultiplier || 1.0}`;
        mapString += `?SupplyCrateLootQualityMultiplier=${config.supplyCrateLootQualityMultiplier || 1.0}`;
        mapString += `?FishingLootQualityMultiplier=${config.fishingLootQualityMultiplier || 1.0}`;

        mapString += `?StructurePickupTimeAfterPlacement=${config.structurePickupTimeAfterPlacement || 30}`;
        mapString += `?MaxStructuresInRange=${config.maxStructuresInRange || 10500}`;
        mapString += `?PlatformSaddleBuildAreaBoundsMultiplier=${config.platformSaddleBuildAreaBoundsMultiplier || 1.0}`;
        mapString += `?MaxPlatformSaddleStructureLimit=${config.maxPlatformSaddleStructureLimit || 100}`;
        
        if (config.maxNumberOfPlayersInTribe > 0) mapString += `?MaxNumberOfPlayersInTribe=${config.maxNumberOfPlayersInTribe}`;
        if (config.kickIdlePlayersPeriod > 0) mapString += `?KickIdlePlayersPeriod=${config.kickIdlePlayersPeriod}`;
        if (config.preventOfflinePvPInterval > 0) mapString += `?PreventOfflinePvPInterval=${config.preventOfflinePvPInterval}`;
        if (config.maxPersonalTamedDinos > 0) mapString += `?MaxPersonalTamedDinos=${config.maxPersonalTamedDinos}`;

        // 附加 test7 中的布尔规则参数
        mapString += `?AllowCaveBuildingPvE=${config.allowCaveBuildingPvE ? 'True' : 'False'}`;
        mapString += `?EnableCryoSicknessPVE=${config.enableCryoSicknessPVE !== false ? 'True' : 'False'}`;
        mapString += `?DisableCryopodFridgeRequirement=${config.disableCryopodFridgeRequirement !== false ? 'True' : 'False'}`;
        mapString += `?bPvEDisableFriendlyFire=${config.bPvEDisableFriendlyFire !== false ? 'True' : 'False'}`;
        mapString += `?bDisableDinoDecayPvE=${config.disableDinoDecayPvE ? 'True' : 'False'}`;
        mapString += `?AllowAnyoneBabyImprintCuddle=${config.allowAnyoneBabyImprintCuddle ? 'True' : 'False'}`;
        mapString += `?PreventOfflinePvP=${config.preventOfflinePvP ? 'True' : 'False'}`;
        mapString += `?bUseCorpseLocator=${config.useCorpseLocator !== false ? 'True' : 'False'}`;
        mapString += `?DisableWeatherFog=${config.disableWeatherFog ? 'True' : 'False'}`;
        
        mapString += `?bAutoUnlockAllEngrams=${config.autoUnlockAllEngrams ? 'True' : 'False'}`;
        mapString += `?AutoDestroyDecayedDinos=${config.autoDestroyDecayedDinos ? 'True' : 'False'}`;
        mapString += `?DisableImprintDinoBuff=${config.disableImprintDinoBuff ? 'True' : 'False'}`;
        mapString += `?bPreventMateBoost=${config.preventMateBoost ? 'True' : 'False'}`;
        mapString += `?AllowIntegratedSPlusStructures=${config.allowIntegratedSPlusStructures !== false ? 'True' : 'False'}`;
        mapString += `?bDisableStructureDecayPvE=${config.bDisableStructureDecayPvE ? 'True' : 'False'}`;
        mapString += `?bAllowPlatformSaddleMultiFloors=${config.bAllowPlatformSaddleMultiFloors !== false ? 'True' : 'False'}`;
        mapString += `?DisableCryopodEnemyCheck=${config.disableCryopodEnemyCheck !== false ? 'True' : 'False'}`;
        mapString += `?AllowCryoFridgeOnSaddle=${config.allowCryoFridgeOnSaddle !== false ? 'True' : 'False'}`;
        mapString += `?AllowCustomRecipes=${config.allowCustomRecipes !== false ? 'True' : 'False'}`;
        mapString += `?bPvEAllowTribeWar=${config.bPvEAllowTribeWar !== false ? 'True' : 'False'}`;
        mapString += `?AllowHitMarkers=${config.allowHitMarkers !== false ? 'True' : 'False'}`;

        if (config.enablePvE) mapString += `?ServerPVE=True`;
        if (config.enableRcon !== false) {
            mapString += `?RCONEnabled=True`;
            mapString += `?RCONPort=${config.rconPort || 27020}`;
        }
        if (config.showFloatingDamageText) mapString += `?ShowFloatingDamageText=True`;

        // 管理员密码必须是最后一个带问号的参数
        if (config.adminPassword) mapString += `?ServerAdminPassword=${config.adminPassword}`;

        let args = [mapString];
        
        // ASA 要求使用 -port 和 -WinLiveMaxPlayers
        args.push(`-port=${config.port || 7777}`);
        args.push(`-WinLiveMaxPlayers=${config.maxPlayers || 70}`);

        if (config.useForceRespawnDinos) args.push(`-ForceRespawnDinos`);
        if (config.crossplay !== false) args.push(`-crossplay`); // 默认开启跨平台

        // 白名单
        if (config.useExclusiveList) args.push(`-exclusivejoin`);

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

        // 启动自动备份定时器
        if (config.enableAutoBackup && config.autoBackupInterval > 0) {
            const intervalMs = config.autoBackupInterval * 60 * 1000;
            broadcastLog(`[系统] 已开启自动备份，每 ${config.autoBackupInterval} 分钟执行一次。`);
            autoBackupTimer = setInterval(() => {
                if (serverStatus === 'running') {
                    performBackup(config);
                }
            }, intervalMs);
        }

        serverProcess.stdout.on('data', (data) => {
            broadcastLog(data.toString().trim());
        });

        serverProcess.stderr.on('data', (data) => {
            const msg = formatServerStderrChunk(data);
            if (msg) broadcastLog(msg);
        });

        serverProcess.on('close', (code) => {
            serverProcess = null;
            broadcastStatus('stopped');
            broadcastLog(`服务器进程已退出，退出码: ${code}`);
            
            // 清理自动备份定时器
            if (autoBackupTimer) {
                clearInterval(autoBackupTimer);
                autoBackupTimer = null;
            }
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
        const response = await executeRconCommand('SaveWorld');
        broadcastLog(`[RCON] SaveWorld 已发送`);
        if (response && String(response).trim() && !String(response).includes('无文本回复')) {
            broadcastLog(`[RCON] 回复: ${response}`);
        }
        return res.json({ success: true, message: '已通过 RCON 发送存档命令', response });
    } catch (err) {
        broadcastLog(`[RCON] 存档失败: ${err.message}（ASA 专用服不接受通过本面板管道输入控制台命令，请修复 RCON）`);
        return res.status(500).json({ error: '存档命令发送失败: ' + err.message });
    }
});

// API: 发送自定义 RCON 命令
app.post('/api/server/rcon', async (req, res) => {
    if (!serverProcess || serverStatus !== 'running') {
        return res.status(400).json({ error: '服务器未运行，无法发送命令' });
    }

    const { command } = req.body;
    if (!command) {
        return res.status(400).json({ error: '命令不能为空' });
    }

    try {
        const response = await executeRconCommand(command);
        broadcastLog(`[RCON] > ${command}`);
        if (response && String(response).trim()) {
            broadcastLog(`[RCON] 回复:\n${response}`);
        } else {
            broadcastLog(`[RCON] 命令已发送（无文本回复）`);
        }
        return res.json({ success: true, response });
    } catch (err) {
        broadcastLog(`[RCON] 命令失败: ${err.message}`);
        return res.status(500).json({ error: '命令发送失败: ' + err.message });
    }
});

// 提取的自动备份核心逻辑
function performBackup(config) {
    try {
        const savedDir = path.join(DEFAULT_INSTALL_PATH, 'ShooterGame\\Saved');
        
        // 强制使用默认备份路径 (项目根目录的 backups 文件夹)
        const backupDir = path.join(process.cwd(), 'backups');

        if (!fs.existsSync(savedDir)) {
            broadcastLog('[系统] 未找到存档目录，跳过本次自动备份。');
            return false;
        }

        if (!fs.existsSync(backupDir)) {
            try {
                fs.mkdirSync(backupDir, { recursive: true });
            } catch (err) {
                broadcastLog(`[系统] 无法创建自动备份目录 ${backupDir}，跳过备份。`);
                return false;
            }
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `backup_${timestamp}.zip`;
        const backupFilePath = path.join(backupDir, backupFileName);

        const output = fs.createWriteStream(backupFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', function() {
            broadcastLog(`[系统] 自动备份完成: ${backupFileName} (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`);
        });

        archive.on('error', function(err) {
            broadcastLog(`[系统] 自动备份打包出错: ${err.message}`);
        });

        archive.pipe(output);
        archive.directory(savedDir, false);
        archive.finalize();

        return true;
    } catch (err) {
        broadcastLog(`[系统] 自动备份异常: ${err.message}`);
        return false;
    }
}

// API: 手动备份存档
app.post('/api/server/backup', (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const savedDir = path.join(DEFAULT_INSTALL_PATH, 'ShooterGame\\Saved');
        
        // 优先使用自定义备份路径，如果为空则使用默认路径
        let backupDir = path.join(process.cwd(), 'backups');
        if (config.backupPath && config.backupPath.trim() !== '') {
            backupDir = config.backupPath.trim();
        }

        if (!fs.existsSync(savedDir)) {
            return res.status(400).json({ error: '未找到存档目录，请确认服务器是否已启动过。' });
        }

        if (!fs.existsSync(backupDir)) {
            try {
                fs.mkdirSync(backupDir, { recursive: true });
            } catch (err) {
                return res.status(500).json({ error: `无法创建备份目录 ${backupDir}，请检查路径权限。` });
            }
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
            broadcastLog(`备份文件保存在: ${backupFilePath}`);
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
            return res.json({ backups: [], backupDir });
        }
        // 获取详细的文件信息并按文件修改时间排序
        const files = fs.readdirSync(backupDir)
            .filter(file => file.endsWith('.zip'))
            .map(file => {
                const stat = fs.statSync(path.join(backupDir, file));
                return {
                    name: file,
                    time: stat.mtime.getTime(),
                    dateString: stat.mtime.toLocaleString('zh-CN', { hour12: false }),
                    size: (stat.size / 1024 / 1024).toFixed(2) + ' MB'
                };
            })
            .sort((a, b) => a.time - b.time);
            
        res.json({ backups: files, backupDir });
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
        const backupDir = path.join(process.cwd(), 'backups');

        const backupFilePath = path.join(backupDir, file);
        const savedDir = path.join(DEFAULT_INSTALL_PATH, 'ShooterGame\\Saved');

        if (!fs.existsSync(backupFilePath)) {
            return res.status(404).json({ error: `备份文件不存在于路径: ${backupFilePath}` });
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

// API: 删除存档
app.post('/api/server/delete-backup', (req, res) => {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: '未提供备份文件名' });

    try {
        const backupDir = path.join(process.cwd(), 'backups');

        const backupFilePath = path.join(backupDir, file);

        if (!fs.existsSync(backupFilePath)) {
            return res.status(404).json({ error: `备份文件不存在于路径: ${backupFilePath}` });
        }

        fs.unlinkSync(backupFilePath);
        broadcastLog(`[系统] 已删除备份文件: ${file}`);
        res.json({ success: true, message: '删除成功' });
    } catch (err) {
        res.status(500).json({ error: '删除备份失败: ' + err.message });
    }
});

// API: 获取服务器性能数据
app.get('/api/server/performance', (req, res) => {
    if (!serverProcess || serverStatus !== 'running') {
        return res.json({ cpu: 0, mem: 0, totalMemory: os.totalmem() }); // 返回数字以便前端进度条处理
    }

    pidusage(serverProcess.pid, (err, stats) => {
        if (err) {
            return res.json({ cpu: 0, mem: 0, totalMemory: os.totalmem() });
        }
        
        // stats.cpu: CPU 占用百分比
        // stats.memory: 内存占用 (Bytes)
        const cpuPercent = stats.cpu.toFixed(1);
        const memMB = (stats.memory / 1024 / 1024).toFixed(2);
        
        res.json({ cpu: Number(cpuPercent), mem: Number(memMB), totalMemory: os.totalmem() });
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

// API: 获取在线玩家数 (使用 RCON 命令 listplayers 获取)
app.get('/api/server/players', async (req, res) => {
    if (!serverProcess || serverStatus !== 'running') {
        return res.json({ success: false, players: 0 });
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        if (!config.enableRcon) {
            return res.json({ success: false, players: '?' });
        }

        // 使用新写的 RCON 函数去执行 listplayers
        const response = await executeRconCommand('listplayers');
        const responseText = String(response || '').trim();

        // 典型的无玩家回复: "No Players Connected"
        if (responseText === '' || responseText.includes('No Players Connected') || responseText.includes('无文本回复')) {
            return res.json({ success: true, players: 0 });
        } else {
            // listplayers 的返回格式通常是一行一个玩家，或者带编号的列表
            const lines = responseText.split('\n');
            // 过滤掉空行和明显不是玩家的提示信息
            const playerCount = lines.filter(line => line.trim().length > 0 && !line.includes('No Players')).length;
            return res.json({ success: true, players: playerCount });
        }
    } catch (err) {
        // 如果 RCON 没连上，就返回占位符
        return res.json({ success: false, players: '?' });
    }
});

// 删除旧的固定端口监听
// server.listen(3000, () => {
//     console.log('Server is running on port 3000');
// });