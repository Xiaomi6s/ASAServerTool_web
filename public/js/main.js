document.addEventListener('DOMContentLoaded', () => {
    // 元素引用
    const form = document.getElementById('configForm');
    const btnStart = document.getElementById('btnStart');
    const btnSave = document.getElementById('btnSave');
    const btnStop = document.getElementById('btnStop');
    const btnUpdate = document.getElementById('btnUpdate');
    const btnUpdateText = document.getElementById('btnUpdateText');
    const btnBackup = document.getElementById('btnBackup');
    const btnClearLog = document.getElementById('btnClearLog');
    const consoleLog = document.getElementById('consoleLog');
    const statusBadge = document.getElementById('statusBadge');
    const installStatusText = document.getElementById('installStatusText');
    const serverMapBadge = document.getElementById('serverMapBadge');
    const serverMapText = document.getElementById('serverMapText');
    const cpuUsageText = document.getElementById('cpuUsageText');
    const memUsageText = document.getElementById('memUsageText');
    const cpuBar = document.getElementById('cpuBar');
    const memBar = document.getElementById('memBar');
    const onlinePlayersText = document.getElementById('onlinePlayersText');
    const serverAddressBadge = document.getElementById('serverAddressBadge');
    const serverIpPortText = document.getElementById('serverIpPortText');

    // 表单元素
    const fields = [
        // 服务器设置
        'serverName', 'maxPlayers', 'map', 'serverPassword', 'adminPassword', 'port', 'queryPort', 'enableRcon', 'rconPort', 'mods', 'noBattlEye', 'autoManagedMods', 'autoSavePeriod', 'backupPath', 'customArgs',
        // 玩家
        'playerDamage', 'playerResistance', 'playerWaterDrain', 'playerFoodDrain', 'playerStaminaDrain', 'playerHealthRecovery', 'playerHarvestingDamage',
        // 生物
        'dinoCount', 'maxTamedDinos', 'dinoDamage', 'dinoResistance', 'dinoFoodDrain', 'dinoStaminaDrain', 'dinoHealthRecovery', 'dinoHarvestingDamage', 'dinoTurretDamage',
        'disableTame', 'disableRiding', 'matingInterval', 'matingSpeed', 'eggHatchSpeed', 'babyMatureSpeed', 'babyImprintAmountMultiplier', 'babyCuddleInterval', 'babyImprintingStatScale', 'babyFoodConsumptionSpeed', 'babyCuddleGracePeriod', 'babyCuddleLoseImprintQualitySpeed',
        // 建筑
        'structureDamage', 'structureResistance', 'platformMaxStructuresMultiplier', 'disableStructurePlacementCollision',
        // 世界
        'dayTimeSpeed', 'nightTimeSpeed', 'resourcesRespawnPeriodMultiplier', 'resourceNoReplenishRadiusPlayers', 'cropGrowthSpeedMultiplier', 'poopIntervalMultiplier', 'layEggIntervalMultiplier', 'globalSpoilingTimeMultiplier', 'globalItemDecompositionTimeMultiplier', 'globalCorpseDecompositionTimeMultiplier', 'allowThirdPerson', 'showMapPlayerLocation', 'enableCrosshair', 'forceAllowCaveFlyers', 'allowFlyerCarryPvE',
        // 规则
        'xpMultiplier', 'tamingMultiplier', 'harvestMultiplier', 'difficultyOffset', 'maximizeDifficulty',
        'allowSpeedLeveling', 'allowFlyerSpeedLeveling', 'enablePvE', 'hardcoreMode', 'allowUnlimitedRespecs',
        'showFloatingDamageText', 'allowThirdPerson', 'globalVoiceChat', 'proximityChat', 'alwaysNotifyPlayerJoin', 'alwaysNotifyPlayerLeft', 'serverAdminLog', 'enableCrosshair',
        'forceNoHUD', 'preventDownloadSurvivors', 'preventDownloadDinos', 'preventDownloadItems', 'noTributeDownloads',
        'enablePvPGamma', 'showCreativeMode', 'disableLootCrates', 'disableFriendlyFire', 'allowCaveBuildingPvE', 'enableCryoSicknessPVE', 'disableCryopodFridgeRequirement', 'bPvEDisableFriendlyFire', 'useForceRespawnDinos', 'disableDinoDecayPvE', 'allowAnyoneBabyImprintCuddle', 'preventOfflinePvP', 'useCorpseLocator', 'disableWeatherFog', 'crossplay', 'useSingleplayerSettings', 'activeEvent'
    ];

    // 1. 获取初始配置和安装状态
    let isServerInstalled = false;
    function checkInstallStatus() {
        fetch('/api/server/install-status')
            .then(res => res.json())
            .then(data => {
                isServerInstalled = data.installed;
                btnUpdate.style.display = 'inline-block'; // 检测完毕后显示按钮
                
                if (data.installed) {
                    installStatusText.textContent = '已安装';
                    installStatusText.className = 'text-success fw-bold';
                    btnUpdateText.textContent = '检查更新';
                    btnUpdate.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i><span id="btnUpdateText">检查更新</span>';
                } else {
                    installStatusText.textContent = '未安装';
                    installStatusText.className = 'text-danger fw-bold';
                    btnUpdateText.textContent = '一键下载安装';
                    btnUpdate.innerHTML = '<i class="bi bi-cloud-download me-1"></i><span id="btnUpdateText">一键下载安装</span>';
                }
            })
            .catch(err => {
                installStatusText.textContent = '检测失败';
                installStatusText.className = 'text-warning';
                btnUpdate.style.display = 'none';
            });
    }

    function loadConfig(isManual = false) {
        if (isManual) {
            const btn = document.getElementById('btnLoadConfig');
            if (btn) {
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>加载中...';
                btn.disabled = true;
                
                fetch('/api/config')
                    .then(res => res.json())
                    .then(data => {
                        fields.forEach(field => {
                            const el = document.getElementById(field);
                            if (el) {
                                if (field === 'enableRcon' && data[field] === undefined) {
                                    el.checked = true;
                                } else if (field === 'rconPort' && data[field] === undefined) {
                                    el.value = 27020;
                                } else if (el.type === 'checkbox') {
                                    el.checked = data[field] !== undefined ? !!data[field] : el.checked;
                                } else {
                                    el.value = data[field] !== undefined ? data[field] : el.value;
                                }
                            }
                        });
                        alert('配置已重新加载！');
                    })
                    .catch(err => {
                        alert('加载配置失败: ' + err.message);
                        appendLog('加载配置失败: ' + err.message);
                    })
                    .finally(() => {
                        btn.innerHTML = originalHtml;
                        btn.disabled = false;
                    });
                return;
            }
        }

        fetch('/api/config')
            .then(res => res.json())
            .then(data => {
                fields.forEach(field => {
                    const el = document.getElementById(field);
                    if (el) {
                        if (field === 'enableRcon' && data[field] === undefined) {
                            el.checked = true;
                        } else if (field === 'rconPort' && data[field] === undefined) {
                            el.value = 27020;
                        } else if (el.type === 'checkbox') {
                            el.checked = data[field] !== undefined ? !!data[field] : el.checked;
                        } else {
                            el.value = data[field] !== undefined ? data[field] : el.value;
                        }
                    }
                });
                checkInstallStatus();
            })
            .catch(err => appendLog('获取配置失败: ' + err.message));
    }

    // 初始加载
    loadConfig();

    const btnLoadConfig = document.getElementById('btnLoadConfig');
    if (btnLoadConfig) {
        btnLoadConfig.addEventListener('click', () => {
            loadConfig(true);
        });
    }

    // 文件夹选择器逻辑
    const btnSelectBackupDir = document.getElementById('btnSelectBackupDir');
    if (btnSelectBackupDir) {
        btnSelectBackupDir.addEventListener('click', () => {
            const originalHtml = btnSelectBackupDir.innerHTML;
            btnSelectBackupDir.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
            btnSelectBackupDir.disabled = true;

            fetch('/api/server/select-folder')
                .then(res => res.json())
                .then(data => {
                    if (data.path) {
                        document.getElementById('backupPath').value = data.path;
                    } else if (data.error) {
                        alert(data.error);
                    }
                })
                .catch(err => {
                    alert('无法调用文件夹选择器: ' + err.message);
                })
                .finally(() => {
                    btnSelectBackupDir.innerHTML = originalHtml;
                    btnSelectBackupDir.disabled = false;
                });
        });
    }

    // 2. 建立 WebSocket 连接接收日志和状态
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
            appendLog(data.message);
        } else if (data.type === 'status') {
            updateStatus(data.status);
        }
    };

    ws.onclose = () => {
        appendLog('[警告] 与服务器的 WebSocket 连接已断开。');
        updateStatus('disconnected');
    };

    // 3. 保存配置
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const newConfig = {};
        fields.forEach(field => {
            const el = document.getElementById(field);
            if (el) {
                // 简单类型转换
                if (el.type === 'number') {
                    newConfig[field] = Number(el.value);
                } else if (el.type === 'checkbox') {
                    newConfig[field] = el.checked;
                } else {
                    newConfig[field] = el.value;
                }
            }
        });

        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newConfig)
        })
        .then(res => res.json())
        .then(data => {
            if(data.success) {
                alert('配置保存成功！');
                checkInstallStatus(); // 配置保存后重新检测安装状态
            } else {
                alert('保存失败: ' + data.error);
            }
        });
    });

    // 4. 启停和更新控制
    btnStart.addEventListener('click', () => {
        fetch('/api/server/start', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                if(data.error) alert(data.error);
            });
    });

    btnSave.addEventListener('click', () => {
        fetch('/api/server/save', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                if(data.error) alert(data.error);
            });
    });

    const btnConfirmStop = document.getElementById('btnConfirmStop');
    if (btnConfirmStop) {
        btnConfirmStop.addEventListener('click', () => {
            // 关闭 Modal
            const stopModalEl = document.getElementById('stopConfirmModal');
            const modalInstance = bootstrap.Modal.getInstance(stopModalEl);
            if (modalInstance) {
                modalInstance.hide();
            }

            fetch('/api/server/stop', { method: 'POST' })
                .then(res => res.json())
                .then(data => {
                    if(data.error) alert(data.error);
                });
        });
    }

    btnUpdate.addEventListener('click', () => {
        const confirmMsg = isServerInstalled 
            ? '确定要检查并更新服务端吗？这可能需要一些时间，更新期间不要关闭面板。' 
            : '确定要开始下载安装服务端吗？由于文件较大（约几十GB），这需要较长时间，请耐心等待并在右侧查看进度。';
            
        if(confirm(confirmMsg)) {
            fetch('/api/server/update', { method: 'POST' })
                .then(res => res.json())
                .then(data => {
                    if(data.error) alert(data.error);
                });
        }
    });

    btnBackup.addEventListener('click', () => {
        fetch('/api/server/backup', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                if(data.error) {
                    alert(data.error);
                } else {
                    alert(data.message);
                }
            });
    });

    const restoreModalEl = document.getElementById('restoreModal');
    if (restoreModalEl) {
        restoreModalEl.addEventListener('show.bs.modal', () => {
            const backupList = document.getElementById('backupList');
            backupList.innerHTML = '<div class="text-center p-3 text-muted small">加载中...</div>';
            
            fetch('/api/server/backups')
                .then(res => res.json())
                .then(data => {
                    if (data.backups && data.backups.length > 0) {
                        backupList.innerHTML = '';
                        // 倒序排列，最新的在前面
                        data.backups.reverse().forEach(file => {
                            const btn = document.createElement('button');
                            btn.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
                            btn.innerHTML = `
                                <span><i class="bi bi-file-zip me-2 text-secondary"></i>${file}</span>
                                <span class="btn btn-sm btn-outline-primary rounded-pill px-3">恢复</span>
                            `;
                            btn.addEventListener('click', () => {
                                if (confirm(`确定要恢复存档 [ ${file} ] 吗？这会覆盖当前的存档数据！\n建议在执行前先停止服务器并进行一次新的备份。`)) {
                                    // 关闭 Modal
                                    const modalInstance = bootstrap.Modal.getInstance(restoreModalEl);
                                    modalInstance.hide();
                                    
                                    // 发送恢复请求
                                    fetch('/api/server/restore', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ file })
                                    })
                                    .then(r => r.json())
                                    .then(resData => {
                                        if(resData.error) alert(resData.error);
                                        else alert('恢复成功！');
                                    });
                                }
                            });
                            backupList.appendChild(btn);
                        });
                    } else {
                        backupList.innerHTML = '<div class="text-center p-3 text-muted small">暂无备份记录</div>';
                    }
                })
                .catch(() => {
                    backupList.innerHTML = '<div class="text-center p-3 text-danger small">加载失败</div>';
                });
        });
    }

    // 5. 定时获取性能数据和在线人数 (仅在运行时)
    setInterval(() => {
        if (statusBadge.textContent === '运行中') {
            fetch('/api/server/performance')
                .then(res => res.json())
                .then(data => {
                    const cpu = data.cpu || 0;
                    const memMB = data.mem || 0;
                    const memGB = (memMB / 1024).toFixed(2);
                    const totalMemGB = ((data.totalMemory || 0) / 1024 / 1024 / 1024).toFixed(2);
                    
                    cpuUsageText.textContent = `${cpu.toFixed(1)}%`;
                    cpuBar.style.width = `${Math.min(cpu, 100)}%`;
                    
                    let memPercent = 0;
                    if (totalMemGB > 0) {
                        memUsageText.textContent = `${memGB} GB / ${totalMemGB} GB`;
                        memPercent = ((memMB / 1024) / totalMemGB) * 100;
                        memBar.style.width = `${Math.min(memPercent, 100)}%`;
                    } else {
                        memUsageText.textContent = `${memGB} GB / 未知`;
                        memBar.style.width = `0%`;
                    }

                    // 根据占用率改变颜色
                    cpuBar.className = `progress-bar ${cpu > 80 ? 'bg-danger' : (cpu > 50 ? 'bg-warning' : 'bg-info')}`;
                    memBar.className = `progress-bar ${memPercent > 80 ? 'bg-danger' : (memPercent > 50 ? 'bg-warning' : 'bg-success')}`;
                })
                .catch(() => {});
                
            // 获取在线人数 (需后端支持RCON或日志解析，目前展示占位逻辑，后续可完善)
            fetch('/api/server/players')
                .then(res => res.json())
                .then(data => {
                    const maxPlayers = document.getElementById('maxPlayers').value || 70;
                    if (data.success) {
                        onlinePlayersText.textContent = `${data.players} / ${maxPlayers}`;
                    } else {
                        // RCON连接失败或者未开启时显示问号
                        onlinePlayersText.textContent = `? / ${maxPlayers}`;
                    }
                })
                .catch(() => {
                    const maxPlayers = document.getElementById('maxPlayers').value || 70;
                    onlinePlayersText.textContent = `? / ${maxPlayers}`;
                });
        } else {
            cpuUsageText.textContent = '0.0%';
            memUsageText.textContent = '0 GB / 0 GB';
            cpuBar.style.width = '0%';
            memBar.style.width = '0%';
            serverAddressBadge.style.display = 'none';
            
            const maxPlayers = document.getElementById('maxPlayers').value || 70;
            onlinePlayersText.textContent = `0 / ${maxPlayers}`;
        }
    }, 3000); // 每 3 秒更新一次

    // 6. 清空日志
    btnClearLog.addEventListener('click', () => {
        consoleLog.innerHTML = '';
    });

    // 7. RCON 命令相关
    const commandSearch = document.getElementById('commandSearch');
    const commandSelect = document.getElementById('commandSelect');
    const rconInput = document.getElementById('rconInput');
    const rconForm = document.getElementById('rconForm');

    // 定义所有的可用命令
    const rconCommands = [
        { cmd: 'SaveWorld', desc: '立即保存世界 (baocun)' },
        { cmd: 'DoExit', desc: '安全关闭服务器 (guanbi/exit)' },
        { cmd: 'Broadcast ', desc: '发送全服广播 [Message] (guangbo)' },
        { cmd: 'ServerChat ', desc: '发送服务器聊天 [Message] (liaotian)' },
        { cmd: 'ListPlayers', desc: '列出在线玩家 (wanjia/list)' },
        { cmd: 'KickPlayer ', desc: '踢出玩家 [SteamID] (tiren/kick)' },
        { cmd: 'BanPlayer ', desc: '封禁玩家 [SteamID] (fengjin/ban)' },
        { cmd: 'UnbanPlayer ', desc: '解封玩家 [SteamID] (jiefeng/unban)' },
        { cmd: 'DestroyWildDinos', desc: '销毁所有野生恐龙 (xiaohui/konglong)' },
        { cmd: 'SetTimeOfDay ', desc: '设置游戏时间 [Hour:Minute] (shijian/time)' },
        { cmd: 'Slomo ', desc: '设置游戏速度 [Multiplier] (sudu/speed)' },
        { cmd: 'GetChat', desc: '获取聊天记录 (jilu/chat)' },
        { cmd: 'SetMessageOfTheDay ', desc: '设置每日消息 [Message] (xiaoxi/motd)' },
        { cmd: 'PlaySound ', desc: '播放声音 [SoundName] (shengyin/sound)' },
        { cmd: 'Teleport', desc: '传送到你准星指向的位置 (chuansong/tp)' },
        { cmd: 'God', desc: '开启/关闭无敌模式 (wudi/god)' },
        { cmd: 'Fly', desc: '开启飞行模式 (feixing/fly)' },
        { cmd: 'Walk', desc: '关闭飞行模式/穿墙模式 (buxing/walk)' },
        { cmd: 'Ghost', desc: '开启穿墙模式 (chuanqiang/ghost)' },
        { cmd: 'GiveItemNum ', desc: '给予指定物品 [ItemID] [Quantity] [Quality] [ForceBlueprint] (wupin/item)' },
        { cmd: 'GiveResources', desc: '给予所有基础资源各50份 (ziyuan/resource)' },
        { cmd: 'GMBuff', desc: '开启上帝模式，无限属性并提升等级 (shangdi/gmbuff)' },
        { cmd: 'InfiniteStats', desc: '无限状态(血、耐力、氧气等) (wuxian/stats)' },
        { cmd: 'LeaveMeAlone', desc: '结合了God, InfiniteStats, 隐身 (wudi/leave)' },
        { cmd: 'ForceTame', desc: '强制驯服准星指向的恐龙(可骑乘) (xunfu/tame)' },
        { cmd: 'DoTame', desc: '驯服准星指向的恐龙(需鞍) (xunfu/dotame)' },
        { cmd: 'SpawnDino ', desc: '生成恐龙 [BlueprintPath] [Distance] [Y-Offset] [Z-Offset] [Level] (shengcheng/spawn)' },
        { cmd: 'Summon ', desc: '召唤恐龙 [Type] (zhaohuan/summon)' },
        { cmd: 'Kill', desc: '秒杀准星指向的目标 (jisha/kill)' },
        { cmd: 'Destroymytarget', desc: '直接删除准星指向的目标(不留尸体) (shanchu/destroy)' },
        { cmd: 'AddExperience ', desc: '给予经验值 [Amount] [FromTribe] [PreventSharing] (jingyan/exp)' },
        { cmd: 'GiveEngrams', desc: '解锁所有印痕技能 (yinchen/engrams)' },
        { cmd: 'SetPlayerPos ', desc: '传送到指定坐标 [X] [Y] [Z] (zuobiao/pos)' }
    ];

    // 渲染下拉列表
    function renderCommandList(filterText = '') {
        if (!commandSelect) return;
        
        commandSelect.innerHTML = '';
        const lowerFilter = filterText.toLowerCase();
        
        const filteredCommands = rconCommands.filter(item => 
            item.cmd.toLowerCase().includes(lowerFilter) || 
            item.desc.toLowerCase().includes(lowerFilter)
        );

        if (filteredCommands.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.text = '无匹配命令';
            option.disabled = true;
            commandSelect.appendChild(option);
            commandSelect.size = 2; // 无匹配时高度变小
        } else {
            filteredCommands.forEach(item => {
                const option = document.createElement('option');
                option.value = item.cmd;
                // 去除用于搜索的括号拼音，保持界面整洁
                const cleanDesc = item.desc.split('(')[0].trim();
                option.text = `${item.cmd} - ${cleanDesc}`;
                // 增加内边距，让item不拥挤
                option.className = 'py-2 px-3 border-bottom border-secondary text-light'; 
                commandSelect.appendChild(option);
            });
            // 动态调整高度，最多显示10个
            commandSelect.size = Math.min(filteredCommands.length, 10);
        }
    }

    if (commandSearch && commandSelect && rconInput) {
        // 初始化列表
        renderCommandList();

        // 搜索框输入事件
        commandSearch.addEventListener('input', (e) => {
            const val = e.target.value;
            renderCommandList(val);
            // 只要有输入就显示下拉框（无论是否匹配到，因为有“无匹配”提示）
            commandSelect.style.display = 'block';
        });

        // 搜索框获取焦点时显示下拉列表
        commandSearch.addEventListener('focus', () => {
            commandSelect.style.display = 'block';
            renderCommandList(commandSearch.value);
        });

        // 点击其他地方隐藏下拉框
        document.addEventListener('click', (e) => {
            if (e.target !== commandSearch && e.target !== commandSelect) {
                commandSelect.style.display = 'none';
                commandSearch.value = ''; // 隐藏时也清空搜索状态，恢复占位符
            }
        });

        // 下拉框选择事件
        commandSelect.addEventListener('change', (e) => {
            if (e.target.value) {
                rconInput.value = e.target.value;
                commandSearch.value = ''; // 选中后清空搜索框
                commandSelect.style.display = 'none';
                rconInput.focus();
            }
        });
        
        // 允许在选择列表里点击回车选中
        commandSelect.addEventListener('keydown', (e) => {
             if (e.key === 'Enter') {
                 if (commandSelect.value) {
                     rconInput.value = commandSelect.value;
                     commandSearch.value = ''; // 选中后清空搜索框
                     commandSelect.style.display = 'none';
                     rconInput.focus();
                 }
                 e.preventDefault();
             }
        });
        
        // 允许在搜索框按向下箭头进入列表
        commandSearch.addEventListener('keydown', (e) => {
             if (e.key === 'ArrowDown') {
                 if (commandSelect.options.length > 0 && !commandSelect.options[0].disabled) {
                     commandSelect.focus();
                     commandSelect.selectedIndex = 0;
                 }
                 e.preventDefault();
             }
        });
    }

    if (rconForm) {
        rconForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const command = rconInput.value.trim();
            if (!command) return;

            if (statusBadge.textContent !== '运行中') {
                alert('服务器未运行，无法发送命令！');
                return;
            }

            // 发送命令
            fetch('/api/server/rcon', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command })
            })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    appendLog(`[RCON 发送失败] ${data.error}`);
                } else {
                    // 清空输入框（可选，或者保留方便修改参数）
                    rconInput.value = '';
                    if (commandSearch) commandSearch.value = '';
                }
            })
            .catch(err => {
                appendLog(`[RCON 请求错误] ${err.message}`);
            });
        });
    }

    // 辅助函数
    function appendLog(msg) {
        const div = document.createElement('div');
        div.textContent = msg;
        consoleLog.appendChild(div);
        // 自动滚动到底部
        consoleLog.scrollTop = consoleLog.scrollHeight;
    }

    function updateStatus(status) {
        if (status === 'running') {
            statusBadge.textContent = '运行中';
            statusBadge.className = 'badge bg-success rounded-pill px-3 py-2';
            btnStart.disabled = true;
            btnStop.disabled = false;
            btnUpdate.disabled = true;
            btnSave.disabled = false;
            
            // 显示 IP 和端口
            const port = document.getElementById('port').value || 7777;
            fetch('/api/server/ip')
                .then(res => res.json())
                .then(data => {
                    serverIpPortText.textContent = `${data.ip}:${port}`;
                    serverAddressBadge.style.display = 'inline-block';
                })
                .catch(() => {
                    serverIpPortText.textContent = `127.0.0.1:${port}`;
                    serverAddressBadge.style.display = 'inline-block';
                });
                
            // 显示当前运行的地图
            const mapSelect = document.getElementById('map');
            if (mapSelect && mapSelect.options[mapSelect.selectedIndex]) {
                // 提取括号外的地图英文名或只显示中文
                let mapName = mapSelect.options[mapSelect.selectedIndex].text;
                // 简化显示，例如 "TheIsland_WP (孤岛)" 变为 "孤岛"
                const match = mapName.match(/\(([^)]+)\)/);
                if (match) {
                    mapName = match[1];
                }
                serverMapText.textContent = mapName;
                serverMapBadge.style.display = 'inline-block';
            }
            
        } else if (status === 'stopped') {
            statusBadge.textContent = '已停止';
            statusBadge.className = 'badge bg-light text-dark rounded-pill px-3 py-2 border';
            btnStart.disabled = false;
            btnStop.disabled = true;
            btnUpdate.disabled = false;
            btnSave.disabled = true;
            serverAddressBadge.style.display = 'none';
            serverMapBadge.style.display = 'none';
            // 每次停止时重新检测一下安装状态
            checkInstallStatus();
        } else if (status === 'starting') {
            statusBadge.textContent = '启动中...';
            statusBadge.className = 'badge bg-warning text-dark rounded-pill px-3 py-2';
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnUpdate.disabled = true;
            btnSave.disabled = true;
        } else if (status === 'updating') {
            statusBadge.textContent = '更新/安装中...';
            statusBadge.className = 'badge bg-info text-dark rounded-pill px-3 py-2';
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnUpdate.disabled = true;
            btnSave.disabled = true;
        } else {
            statusBadge.textContent = '连接断开';
            statusBadge.className = 'badge bg-danger rounded-pill px-3 py-2';
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnUpdate.disabled = true;
            btnSave.disabled = true;
        }
    }
});