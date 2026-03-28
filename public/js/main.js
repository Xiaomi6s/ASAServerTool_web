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
        'serverName', 'maxPlayers', 'map', 'serverPassword', 'adminPassword', 'port', 'queryPort', 'enableRcon', 'rconPort', 'mods', 'noBattlEye', 'autoManagedMods', 'autoSavePeriod', 'customArgs',
        // 玩家
        'playerDamage', 'playerResistance', 'playerWaterDrain', 'playerFoodDrain', 'playerStaminaDrain', 'playerHealthRecovery', 'playerHarvestingDamage',
        // 生物
        'dinoCount', 'maxTamedDinos', 'dinoDamage', 'dinoResistance', 'dinoFoodDrain', 'dinoStaminaDrain', 'dinoHealthRecovery', 'dinoHarvestingDamage', 'dinoTurretDamage',
        'disableTame', 'disableRiding', 'matingInterval', 'matingSpeed', 'eggHatchSpeed', 'babyMatureSpeed', 'babyImprintAmountMultiplier', 'babyCuddleInterval', 'babyImprintingStatScale', 'babyFoodConsumptionSpeed', 'babyCuddleGracePeriod', 'babyCuddleLoseImprintQualitySpeed',
        // 建筑
        'structureDamage', 'structureResistance', 'platformMaxStructuresMultiplier', 'disableStructurePlacementCollision',
        // 世界
        'dayTimeSpeed', 'nightTimeSpeed', 'allowThirdPerson', 'showMapPlayerLocation', 'enableCrosshair', 'forceAllowCaveFlyers', 'allowFlyerCarryPvE',
        // 规则
        'xpMultiplier', 'tamingMultiplier', 'harvestMultiplier', 'difficultyOffset', 'maximizeDifficulty',
        'allowSpeedLeveling', 'allowFlyerSpeedLeveling', 'enablePvE', 'hardcoreMode', 'allowUnlimitedRespecs',
        'allowThirdPerson', 'globalVoiceChat', 'proximityChat', 'alwaysNotifyPlayerJoin', 'alwaysNotifyPlayerLeft', 'serverAdminLog', 'enableCrosshair',
        'forceNoHUD', 'preventDownloadSurvivors', 'preventDownloadDinos', 'preventDownloadItems', 'noTributeDownloads',
        'enablePvPGamma', 'showCreativeMode', 'disableLootCrates', 'disableFriendlyFire', 'useSingleplayerSettings', 'activeEvent'
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
                    const cpuVal = data.cpu || 0;
                    const memVal = data.mem || 0;
                    
                    cpuUsageText.textContent = `${cpuVal}%`;
                    memUsageText.textContent = `${memVal} MB`;
                    
                    // 假设服务器最大内存为 32GB (32768 MB) 用于计算进度条比例，或者可以设置得更小
                    const memMax = 16384; 
                    let memPercent = (memVal / memMax) * 100;
                    if(memPercent > 100) memPercent = 100;

                    let cpuPercent = cpuVal;
                    if(cpuPercent > 100) cpuPercent = 100;

                    cpuBar.style.width = `${cpuPercent}%`;
                    memBar.style.width = `${memPercent}%`;

                    // 根据占用率改变颜色
                    cpuBar.className = `progress-bar ${cpuPercent > 80 ? 'bg-danger' : (cpuPercent > 50 ? 'bg-warning' : 'bg-info')}`;
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
                        onlinePlayersText.textContent = `? / ${maxPlayers}`;
                    }
                })
                .catch(() => {
                    const maxPlayers = document.getElementById('maxPlayers').value || 70;
                    onlinePlayersText.textContent = `? / ${maxPlayers}`;
                });
        } else {
            cpuUsageText.textContent = '0.0%';
            memUsageText.textContent = '0 MB';
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
            statusBadge.className = 'badge bg-success';
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
            statusBadge.className = 'badge bg-secondary';
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
            statusBadge.className = 'badge bg-warning text-dark';
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnUpdate.disabled = true;
            btnSave.disabled = true;
        } else if (status === 'updating') {
            statusBadge.textContent = '更新/安装中...';
            statusBadge.className = 'badge bg-info text-dark';
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnUpdate.disabled = true;
            btnSave.disabled = true;
        } else {
            statusBadge.textContent = '连接断开';
            statusBadge.className = 'badge bg-danger';
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnUpdate.disabled = true;
            btnSave.disabled = true;
        }
    }
});