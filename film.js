const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const puppeteer = require('puppeteer');
const express = require('express');


const CONFIG = {
    DISCORD_TOKEN: '', 
    GUILD_ID: '',
    COMMAND_CHANNEL_ID: '',
    DEFAULT_VOICE_CHANNEL_ID: '',
    
    MEDIA_PATHS: {
        filmek: 'D:/',
        sorozatok: 'D:/',
        anime: 'D:/',
        zene: 'D:/'
    },
    
    WEB_PORT: 3000,
    VIDEO_EXTENSIONS: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'],
    AUDIO_EXTENSIONS: ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a'],
    
   
    BROWSER_EXECUTABLE: null, 
    AUTO_FULLSCREEN_DELAY: 3000, 
    STREAM_QUALITY: 'high' 
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

currentVoiceConnection = null; 
let audioPlayer = null;
let currentMediaPath = null;
let streamingBrowser = null;
let streamingPage = null;

class ScreenShareHelper {
    static async findBrowserExecutable() {
        const { exec } = require('child_process');
        const os = require('os');
        
        return new Promise((resolve) => {
            if (os.platform() === 'win32') {
                
                const chromePaths = [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
                ];
                
                for (const path of chromePaths) {
                    if (fs.existsSync(path)) {
                        resolve(path);
                        return;
                    }
                }
            }
            resolve(null); 
        });
    }
    
    static getBrowserArgs(quality = 'high') {
        const baseArgs = [
            '--start-maximized',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--allow-running-insecure-content',
            '--autoplay-policy=no-user-gesture-required',
            '--no-user-gesture-required',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI,VizDisplayCompositor',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-background-downloads',
            '--disable-background-networking',
            '--window-position=0,0',
            '--kiosk' 
        ];
        
        
        switch (quality) {
            case 'high':
                baseArgs.push(
                    '--window-size=1920,1080',
                    '--force-device-scale-factor=1',
                    '--high-dpi-support=1'
                );
                break;
            case 'medium':
                baseArgs.push(
                    '--window-size=1600,900',
                    '--force-device-scale-factor=0.9'
                );
                break;
            case 'low':
                baseArgs.push(
                    '--window-size=1280,720',
                    '--force-device-scale-factor=0.8'
                );
                break;
        }
        
        return baseArgs;
    }
}



const app = express();

app.use('/static', express.static('public'));


app.get('/video/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const videoPath = currentMediaPath || filename;
    
    if (!fs.existsSync(videoPath)) {
        return res.status(404).send('Videó nem található');
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, head);
        fs.createReadStream(videoPath).pipe(res);
    }
});


app.get('/player/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Discord Screen Share Player</title>
        <meta charset="UTF-8">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            
            body { 
                background: #000; 
                overflow: hidden;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                cursor: none; /* Egér elrejtése inaktivitás után */
            }
            
            body.active { cursor: default; }
            
            #video { 
                width: 100vw; 
                height: 100vh; 
                object-fit: contain;
                background: #000;
            }
            
            .overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0,0,0,0.7);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 1000;
                transition: opacity 0.3s ease;
            }
            
            .overlay.hidden { 
                opacity: 0; 
                pointer-events: none; 
            }
            
            .controls-panel {
                background: rgba(0,0,0,0.9);
                padding: 30px;
                border-radius: 20px;
                backdrop-filter: blur(10px);
                border: 2px solid #5865F2;
                min-width: 400px;
                text-align: center;
            }
            
            .title {
                color: #fff;
                font-size: 28px;
                font-weight: bold;
                margin-bottom: 20px;
                text-shadow: 0 2px 4px rgba(0,0,0,0.8);
            }
            
            .subtitle {
                color: #B3B3B3;
                font-size: 16px;
                margin-bottom: 25px;
            }
            
            .control-buttons {
                display: flex;
                justify-content: center;
                gap: 15px;
                flex-wrap: wrap;
                margin-bottom: 20px;
            }
            
            .btn {
                background: linear-gradient(135deg, #5865F2, #4752C4);
                color: white;
                border: none;
                padding: 12px 20px;
                border-radius: 12px;
                cursor: pointer;
                font-size: 16px;
                font-weight: 600;
                transition: all 0.3s ease;
                box-shadow: 0 4px 12px rgba(88, 101, 242, 0.3);
                min-width: 120px;
            }
            
            .btn:hover { 
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(88, 101, 242, 0.4);
                background: linear-gradient(135deg, #4752C4, #3C45A5);
            }
            
            .btn:active { 
                transform: translateY(0);
            }
            
            .volume-container {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 15px;
                margin: 20px 0;
            }
            
            .volume-slider {
                width: 150px;
                height: 8px;
                background: #333;
                border-radius: 4px;
                outline: none;
                cursor: pointer;
                appearance: none;
            }
            
            .volume-slider::-webkit-slider-thumb {
                appearance: none;
                width: 20px;
                height: 20px;
                background: #5865F2;
                border-radius: 50%;
                cursor: pointer;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            }
            
            .progress-info {
                background: rgba(255,255,255,0.1);
                padding: 15px;
                border-radius: 12px;
                margin-top: 20px;
            }
            
            .time-display {
                font-family: 'Courier New', monospace;
                font-size: 20px;
                color: #ffffff;
                font-weight: bold;
            }
            
            .progress-bar-container {
                margin: 15px 0;
            }
            
            .progress-bar {
                width: 100%;
                height: 10px;
                background: #333;
                border-radius: 5px;
                cursor: pointer;
                position: relative;
                overflow: hidden;
            }
            
            .progress-filled {
                height: 100%;
                background: linear-gradient(90deg, #5865F2, #7289DA);
                border-radius: 5px;
                width: 0%;
                transition: width 0.2s ease;
                position: relative;
            }
            
            .progress-filled::after {
                content: '';
                position: absolute;
                top: 0;
                right: 0;
                width: 4px;
                height: 100%;
                background: rgba(255,255,255,0.8);
                border-radius: 2px;
            }
            
            .instructions {
                color: #B3B3B3;
                font-size: 14px;
                line-height: 1.6;
                margin-top: 20px;
                text-align: left;
            }
            
            .status {
                position: fixed;
                top: 20px;
                right: 20px;
                background: rgba(0,0,0,0.8);
                color: white;
                padding: 10px 15px;
                border-radius: 8px;
                font-size: 14px;
                z-index: 1001;
                backdrop-filter: blur(10px);
            }
            
            .loading {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                color: white;
                font-size: 24px;
                background: rgba(0,0,0,0.9);
                padding: 30px;
                border-radius: 15px;
                text-align: center;
                z-index: 1002;
                border: 2px solid #5865F2;
            }
            
            .loading-spinner {
                width: 40px;
                height: 40px;
                border: 4px solid #333;
                border-top: 4px solid #5865F2;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 20px auto;
            }
            
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            
            /* Responsive design */
            @media (max-width: 600px) {
                .controls-panel {
                    min-width: 90vw;
                    padding: 20px;
                }
                
                .btn {
                    min-width: 100px;
                    font-size: 14px;
                }
                
                .title {
                    font-size: 24px;
                }
            }
        </style>
    </head>
    <body>
        <div id="loading" class="loading">
            <div>🎬 Videó betöltése...</div>
            <div class="loading-spinner"></div>
        </div>
        
        <div class="status" id="status">⏸️ Szüneteltetve</div>
        
        <video id="video" preload="metadata">
            <source src="/video/${encodeURIComponent(filename)}" type="video/mp4">
            Your browser does not support the video tag.
        </video>
        
        <div class="overlay" id="overlay">
            <div class="controls-panel">
                <div class="title">🎬 Discord Screen Share</div>
                <div class="subtitle">Fejlett videó lejátszó - Streamingre optimalizálva</div>
                
                <div class="control-buttons">
                    <button class="btn" id="playPauseBtn" onclick="togglePlayPause()">▶️ Lejátszás</button>
                    <button class="btn" onclick="seekVideo(-30)">⏪ 30s</button>
                    <button class="btn" onclick="seekVideo(30)">30s ⏩</button>
                    <button class="btn" onclick="toggleFullscreen()">🖥️ Teljes képernyő</button>
                </div>
                
                <div class="volume-container">
                    <span>🔊</span>
                    <input type="range" class="volume-slider" id="volumeSlider" 
                           min="0" max="100" value="100" onchange="setVolume(this.value)">
                    <span id="volumeDisplay">100%</span>
                </div>
                
                <div class="progress-info">
                    <div class="time-display" id="timeDisplay">00:00 / 00:00</div>
                    <div class="progress-bar-container">
                        <div class="progress-bar" id="progressBar">
                            <div class="progress-filled" id="progressFilled"></div>
                        </div>
                    </div>
                </div>
                
                <div class="instructions">
                    <strong>⌨️ Billentyű vezérlés:</strong><br>
                    • <strong>Space</strong> - Lejátszás/Szünet<br>
                    • <strong>← →</strong> - 10s vissza/előre<br>
                    • <strong>↑ ↓</strong> - Hangerő +/-<br>
                    • <strong>F</strong> - Teljes képernyő<br>
                    • <strong>M</strong> - Némítás<br>
                    • <strong>Escape</strong> - Vezérlő panel
                </div>
                
                <button class="btn" onclick="hideControls()" style="margin-top: 20px; background: rgba(255,255,255,0.2);">
                    ✨ Indítás - Vezérlők elrejtése
                </button>
            </div>
        </div>

        <script>
            const video = document.getElementById('video');
            const playPauseBtn = document.getElementById('playPauseBtn');
            const timeDisplay = document.getElementById('timeDisplay');
            const progressFilled = document.getElementById('progressFilled');
            const progressBar = document.getElementById('progressBar');
            const overlay = document.getElementById('overlay');
            const status = document.getElementById('status');
            const loading = document.getElementById('loading');
            const volumeDisplay = document.getElementById('volumeDisplay');
            
            let isControlsVisible = true;
            let mouseTimeout;
            
            
            video.addEventListener('loadstart', () => {
                loading.style.display = 'block';
                status.textContent = '⏳ Betöltés...';
            });
            
            video.addEventListener('canplay', () => {
                loading.style.display = 'none';
                status.textContent = '▶️ Ready to play';
            });
            
            video.addEventListener('timeupdate', updateProgress);
            video.addEventListener('play', () => {
                playPauseBtn.innerHTML = '⏸️ Szünet';
                status.textContent = '▶️ Lejátszás';
            });
            
            video.addEventListener('pause', () => {
                playPauseBtn.innerHTML = '▶️ Lejátszás';
                status.textContent = '⏸️ Szüneteltetve';
            });
            
            video.addEventListener('ended', () => {
                status.textContent = '✅ Befejezve';
                showControls();
            });
            
            
            function updateProgress() {
                const current = video.currentTime;
                const duration = video.duration || 0;
                const progress = (current / duration) * 100;
                
                progressFilled.style.width = progress + '%';
                
                const currentMin = Math.floor(current / 60);
                const currentSec = Math.floor(current % 60);
                const durationMin = Math.floor(duration / 60);
                const durationSec = Math.floor(duration % 60);
                
                timeDisplay.textContent = 
                    \`\${currentMin.toString().padStart(2, '0')}:\${currentSec.toString().padStart(2, '0')} / \${durationMin.toString().padStart(2, '0')}:\${durationSec.toString().padStart(2, '0')}\`;
            }
            
        
            function togglePlayPause() {
                if (video.paused) {
                    video.play();
                } else {
                    video.pause();
                }
            }
            
            function seekVideo(seconds) {
                video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
            }
            
            function setVolume(value) {
                video.volume = value / 100;
                volumeDisplay.textContent = value + '%';
                
                if (value == 0) {
                    status.textContent = '🔇 Némítva';
                } else if (value < 30) {
                    status.textContent = '🔉 Halk';
                } else if (value < 70) {
                    status.textContent = '🔊 Közepes';
                } else {
                    status.textContent = '🔊 Hangos';
                }
            }
            
            function toggleMute() {
                if (video.volume > 0) {
                    video.volume = 0;
                    document.getElementById('volumeSlider').value = 0;
                    volumeDisplay.textContent = '0%';
                } else {
                    video.volume = 1;
                    document.getElementById('volumeSlider').value = 100;
                    volumeDisplay.textContent = '100%';
                }
            }
            
            function toggleFullscreen() {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().then(() => {
                        status.textContent = '🖥️ Teljes képernyő';
                    }).catch(err => {
                        console.log('Fullscreen failed:', err);
                        status.textContent = '❌ Fullscreen hiba';
                    });
                } else {
                    document.exitFullscreen().then(() => {
                        status.textContent = '🪟 Normál nézet';
                    });
                }
            }
            
            function showControls() {
                overlay.classList.remove('hidden');
                isControlsVisible = true;
                document.body.classList.add('active');
            }
            
            function hideControls() {
                overlay.classList.add('hidden');
                isControlsVisible = false;
                document.body.classList.remove('active');
                if (video.paused) {
                    video.play();
                }
            }
            
            
            progressBar.addEventListener('click', (e) => {
                const rect = progressBar.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const newTime = (clickX / rect.width) * video.duration;
                video.currentTime = newTime;
            });
            
           
            document.addEventListener('mousemove', () => {
                if (!isControlsVisible) {
                    document.body.classList.add('active');
                    clearTimeout(mouseTimeout);
                    mouseTimeout = setTimeout(() => {
                        if (!isControlsVisible && !video.paused) {
                            document.body.classList.remove('active');
                        }
                    }, 3000);
                }
            });
            
           
            document.addEventListener('keydown', (e) => {
                switch(e.code) {
                    case 'Space':
                        e.preventDefault();
                        togglePlayPause();
                        break;
                    case 'ArrowLeft':
                        e.preventDefault();
                        seekVideo(-10);
                        break;
                    case 'ArrowRight':
                        e.preventDefault();
                        seekVideo(10);
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        const newVolumeUp = Math.min(100, parseInt(document.getElementById('volumeSlider').value) + 10);
                        document.getElementById('volumeSlider').value = newVolumeUp;
                        setVolume(newVolumeUp);
                        break;
                    case 'ArrowDown':
                        e.preventDefault();
                        const newVolumeDown = Math.max(0, parseInt(document.getElementById('volumeSlider').value) - 10);
                        document.getElementById('volumeSlider').value = newVolumeDown;
                        setVolume(newVolumeDown);
                        break;
                    case 'KeyF':
                        e.preventDefault();
                        toggleFullscreen();
                        break;
                    case 'KeyM':
                        e.preventDefault();
                        toggleMute();
                        break;
                    case 'Escape':
                        e.preventDefault();
                        if (isControlsVisible) {
                            hideControls();
                        } else {
                            showControls();
                        }
                        break;
                }
            });
            
            
            video.addEventListener('click', (e) => {
                if (!isControlsVisible) {
                    togglePlayPause();
                }
            });
            
            
            video.volume = 1.0;
            
            
            setTimeout(() => {
                if (video.readyState >= 2) { 
                    status.textContent = '✨ Kész! ESC = Vezérlők';
                }
            }, 2000);
        </script>
    </body>
    </html>`;
    res.send(html);
});

app.listen(CONFIG.WEB_PORT, () => {
    console.log(`🌐 Videó szerver fut: http://localhost:${CONFIG.WEB_PORT}`);
});


async function joinVoiceChannelById(channelId, guildId) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            throw new Error('Guild nem található');
        }

        const channel = guild.channels.cache.get(channelId);
        
        if (!channel) {
            console.log(`❌ Csatorna nem található ID alapján: ${channelId}`);
            
            const voiceChannels = guild.channels.cache.filter(ch => ch.type === 2);
            if (voiceChannels.size > 0) {
                const firstVoiceChannel = voiceChannels.first();
                console.log(`🔄 Átváltás az első elérhető voice csatornára: ${firstVoiceChannel.name}`);
                return await joinVoiceChannelById(firstVoiceChannel.id, guildId);
            }
            throw new Error('Nincs elérhető voice csatorna');
        }
        
        if (channel.type !== 2) {
            throw new Error(`A csatorna nem voice csatorna. Típus: ${channel.type}`);
        }

        console.log(`🔊 Csatlakozás: ${channel.name} (${channelId})`);

        const connection = joinVoiceChannel({
            channelId: channelId,
            guildId: guildId,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log(`✅ Bot csatlakozott: ${channel.name}`);
        });

        connection.on(VoiceConnectionStatus.Disconnected, () => {
            console.log('❌ Bot lecsatlakozott a voice csatornáról');
        });

        connection.on(VoiceConnectionStatus.Destroyed, () => {
            console.log('🗑️ Voice connection megsemmisítve');
        });

        return connection;
    } catch (error) {
        console.error('Voice csatlakozási hiba:', error.message);
        return null;
    }
}

async function leaveVoiceChannel() {
    if (currentVoiceConnection) {
        currentVoiceConnection.destroy();
        currentVoiceConnection = null;
        console.log('🚪 Bot elhagyta a voice csatornát');
    }
}


async function findAvailableVoiceChannel(guildId) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return null;

       
        const voiceChannels = guild.channels.cache.filter(channel => 
            channel.type === 2 && 
            channel.permissionsFor(guild.members.me).has(['Connect', 'Speak'])
        );

        if (voiceChannels.size === 0) {
            console.log('❌ Nincs elérhető voice csatorna');
            return null;
        }

       
        const channel = voiceChannels.first();
        console.log(`🔍 Talált voice csatorna: ${channel.name} (${channel.id})`);
        return channel.id;
    } catch (error) {
        console.error('Csatorna keresési hiba:', error);
        return null;
    }
}


function scanMediaFolder(folderPath) {
    const mediaFiles = [];
    
    if (!fs.existsSync(folderPath)) {
        console.warn(`⚠️ Mappa nem található: ${folderPath}`);
        return mediaFiles;
    }

    try {
        const items = fs.readdirSync(folderPath, { withFileTypes: true });
        
        for (const item of items) {
            const fullPath = path.join(folderPath, item.name);
            
            if (item.isDirectory()) {
                mediaFiles.push(...scanMediaFolder(fullPath));
            } else if (item.isFile()) {
                const extension = path.extname(item.name).toLowerCase();
                if ([...CONFIG.VIDEO_EXTENSIONS, ...CONFIG.AUDIO_EXTENSIONS].includes(extension)) {
                    mediaFiles.push({
                        name: item.name,
                        title: path.basename(item.name, extension),
                        path: fullPath,
                        extension: extension,
                        size: fs.statSync(fullPath).size,
                        isVideo: CONFIG.VIDEO_EXTENSIONS.includes(extension),
                        isAudio: CONFIG.AUDIO_EXTENSIONS.includes(extension)
                    });
                }
            }
        }
    } catch (error) {
        console.error(`Hiba a mappa olvasásakor: ${folderPath}`, error.message);
    }

    return mediaFiles;
}

function searchMedia(query, category = null) {
    const results = [];
    const searchPaths = category ? { [category]: CONFIG.MEDIA_PATHS[category] } : CONFIG.MEDIA_PATHS;
    
    for (const [catName, folderPath] of Object.entries(searchPaths)) {
        if (!folderPath) continue;
        
        const mediaFiles = scanMediaFolder(folderPath);
        const filtered = mediaFiles.filter(file => 
            file.title.toLowerCase().includes(query.toLowerCase()) ||
            file.name.toLowerCase().includes(query.toLowerCase())
        );
        
        filtered.forEach(file => {
            file.category = catName;
            results.push(file);
        });
    }
    
    return results;
}


async function startAutomaticScreenShare(videoUrl, voiceChannelId, guildId) {
    try {
        console.log('🚀 Fejlesztett stream indítása...');
        
        
        let actualChannelId = voiceChannelId;
        if (!actualChannelId || actualChannelId === 'undefined') {
            actualChannelId = await findAvailableVoiceChannel(guildId);
            if (!actualChannelId) {
                throw new Error('Nincs elérhető voice csatorna');
            }
        }
        
        currentVoiceConnection = await joinVoiceChannelById(actualChannelId, guildId);
        if (!currentVoiceConnection) {
            throw new Error('Nem sikerült csatlakozni a voice csatornához');
        }

        
        const browserExecutable = await ScreenShareHelper.findBrowserExecutable();
        const browserArgs = ScreenShareHelper.getBrowserArgs(CONFIG.STREAM_QUALITY);
        
        const launchOptions = {
            headless: false,
            defaultViewport: null,
            args: browserArgs
        };
        
        if (browserExecutable) {
            launchOptions.executablePath = browserExecutable;
        }
        
        streamingBrowser = await puppeteer.launch(launchOptions);
        streamingPage = await streamingBrowser.newPage();
        
        
        await streamingPage.setViewport({ 
            width: 1920, 
            height: 1080,
            deviceScaleFactor: 1
        });
        
        
        await streamingPage.goto(videoUrl, { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        
        await streamingPage.waitForSelector('#video', { timeout: 15000 });
        
        
        await streamingPage.evaluate((delay) => {
            const video = document.getElementById('video');
            if (video) {
                video.volume = 1.0;
                video.preload = 'auto';
                video.muted = false;
                
                
                const playPromise = video.play();
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.log('Autoplay failed:', error);
                    });
                }
                
                
                setTimeout(() => {
                    if (document.documentElement.requestFullscreen) {
                        document.documentElement.requestFullscreen()
                            .then(() => {
                                console.log('Fullscreen activated');
                                
                                setTimeout(() => {
                                    const overlay = document.getElementById('overlay');
                                    if (overlay) {
                                        overlay.classList.add('hidden');
                                    }
                                }, 2000);
                            })
                            .catch(err => console.log('Fullscreen failed:', err));
                    }
                }, delay);
            }
        }, CONFIG.AUTO_FULLSCREEN_DELAY);

        
        await streamingPage.bringToFront();
        
        console.log('✅ STREAM SIKERESEN ELINDÍTVA!');
        console.log('🖥️ FONTOS: Most oszd meg a képernyődet a Discord voice csatornában!');
        console.log('📺 Kiosk mód: A böngésző teljes képernyős módban fut');
        console.log('🎯 Tipp: Használj Discord overlay-t a könnyebb kezeléshez');
        
        return true;
    } catch (error) {
        console.error('❌ Stream indítási hiba:', error);
        await leaveVoiceChannel();
        await stopScreenShare();
        return false;
    }
}


async function handleStatusCommand(interaction) {
   await interaction.deferReply();
   
   const isStreaming = streamingBrowser && streamingPage;
   const isVoiceConnected = currentVoiceConnection && currentVoiceConnection.state.status === 'ready';
   
   const embed = new EmbedBuilder()
       .setColor(isStreaming ? '#00FF00' : '#FF6B00')
       .setTitle('📊 STREAM STÁTUSZ')
       .setTimestamp();
   
   if (isStreaming) {
       embed.setDescription('🟢 **AKTÍV STREAM**');
       embed.addFields(
           { name: '🎬 Videó', value: currentMediaPath ? path.basename(currentMediaPath) : 'Ismeretlen', inline: true },
           { name: '🔊 Voice', value: isVoiceConnected ? '✅ Csatlakozva' : '❌ Nincs csatlakozva', inline: true },
           { name: '🌐 Webszerver', value: `http://localhost:${CONFIG.WEB_PORT}`, inline: true }
       );
   } else {
       embed.setDescription('🔴 **NINCS AKTÍV STREAM**');
       embed.addFields(
           { name: '💡 Indítás', value: 'Használd a `/indit [név]` parancsot', inline: false }
       );
   }
   
   
   const memUsage = process.memoryUsage();
   embed.addFields(
       { name: '💾 Memória használat', value: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`, inline: true },
       { name: '⏱️ Futási idő', value: `${Math.round(process.uptime() / 60)} perc`, inline: true }
   );
   
   await interaction.editReply({ embeds: [embed] });
}



async function handleTutorialCommand(interaction) {
    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('📖 KÉPERNYŐMEGOSZTÁS ÚTMUTATÓ')
        .setDescription('**Lépésről lépésre útmutató:**')
        .addFields(
            { 
                name: '1️⃣ Videó indítása', 
                value: '• Használd: `/indit [videó neve]`\n• A bot automatikusan megnyitja a lejátszót\n• Csatlakozik a voice csatornához', 
                inline: false 
            },
            { 
                name: '2️⃣ Képernyőmegosztás', 
                value: '• Menj a Discord voice csatornába\n• Kattints a **"Képernyő"** gombra\n• Válaszd ki a **böngésző ablakot**\n• Kattints a **"Élő"** gombra', 
                inline: false 
            },
            { 
                name: '3️⃣ Beállítások', 
                value: '• **Minőség:** 1080p 60fps ajánlott\n• **Hang:** Bekapcsolva\n• **Kamera:** Kikapcsolva', 
                inline: false 
            },
            { 
                name: '⌨️ Vezérlés közben', 
                value: '• **Space:** Szünet/folytatás\n• **F:** Teljes képernyő\n• **ESC:** Vezérlőpanel\n• **←→:** Tekercselés', 
                inline: false 
            },
            { 
                name: '🛠️ Hibaelhárítás', 
                value: '• Ha nincs hang: Ellenőrizd a Discord hang beállításokat\n• Ha lassú: Csökkentsd a minőséget\n• Ha nem látszik: Indítsd újra a streamet', 
                inline: false 
            },
            { 
                name: '🆘 Fontos tippek', 
                value: '• Használj Discord overlay-t\n• Bezárj minden felesleges programot\n• Internetkapcsolat: min. 5 Mbps', 
                inline: false 
            }
        )
        .setFooter({ text: 'Ha továbbra is problémád van, használd a /status parancsot!' })
        .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
}

    

async function stopScreenShare() {
    if (streamingPage) {
        await streamingPage.close();
        streamingPage = null;
    }

    if (streamingBrowser) {
        await streamingBrowser.close();
        streamingBrowser = null;
    }

    await leaveVoiceChannel();

    console.log('🛑 Stream leállítva');
}



const commands = [
    new SlashCommandBuilder()
        .setName('lista')
        .setDescription('Listázza a médiafájlokat kategória szerint')
        .addStringOption(option =>
            option.setName('kategoria')
                .setDescription('Válassz kategóriát')
                .setRequired(true)
                .addChoices(
                    { name: 'Filmek', value: 'filmek' },
                    { name: 'Sorozatok', value: 'sorozatok' },
                    { name: 'Anime', value: 'anime' },
                    { name: 'Zene', value: 'zene' }
                )),

    new SlashCommandBuilder()
        .setName('indit')
        .setDescription('🎬 ELINDÍT EGY VIDEÓT AUTOMATIKUS STREAMINGHEZ')
        .addStringOption(option =>
            option.setName('nev')
                .setDescription('A videó neve (részleges név is működik)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('keres')
        .setDescription('Keres médiafájlokat név alapján')
        .addStringOption(option =>
            option.setName('nev')
                .setDescription('Keresendő név')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('kategoria')
                .setDescription('Szűrés kategóriára (opcionális)')
                .setRequired(false)
                .addChoices(
                    { name: 'Filmek', value: 'filmek' },
                    { name: 'Sorozatok', value: 'sorozatok' },
                    { name: 'Anime', value: 'anime' },
                    { name: 'Zene', value: 'zene' }
                )),

    new SlashCommandBuilder()
        .setName('leallitas')
        .setDescription('⏹️ Leállítja a jelenlegi streamet'),

    new SlashCommandBuilder()
        .setName('info')
        .setDescription('ℹ️ Bot információk és használati útmutató'),

    new SlashCommandBuilder()
        .setName('csatlakozas')
        .setDescription('🔊 Csatlakozás voice csatornához')
        .addChannelOption(option =>
            option.setName('csatorna')
                .setDescription('Voice csatorna (ha nincs megadva, az alapértelmezett csatornát használja)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('kilepes')
        .setDescription('🚪 Kilépés a voice csatornából')
];


const streamStatusCommand = new SlashCommandBuilder()
   .setName('status')
   .setDescription('📊 Jelenlegi stream állapota és információk');

commands.push(streamStatusCommand); 

const tutorialCommand = new SlashCommandBuilder()
    .setName('tutorial')
    .setDescription('📖 Részletes útmutató a képernyőmegosztáshoz');

commands.push(tutorialCommand);






async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
    
    try {
        console.log('🔄 Slash parancsok regisztrálása...');
        
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, CONFIG.GUILD_ID),
            { body: commands.map(cmd => cmd.toJSON()) }
        );
        
        console.log('✅ Slash parancsok sikeresen regisztrálva!');
    } catch (error) {
        console.error('❌ Parancs regisztrálási hiba:', error);
    }
}


client.once('ready', async () => {
    console.log('🤖 Discord Media Bot elindult!');
    console.log(`📡 Bejelentkezve mint: ${client.user.tag}`);
    console.log(`🌐 Webszerver: http://localhost:${CONFIG.WEB_PORT}`);
    
    await registerCommands();
    
    console.log('\n🎯 HASZNÁLATI ÚTMUTATÓ:');
    console.log('1. /lista [kategória] - Fájlok listázása');
    console.log('2. /keres [név] - Fájl keresése');
    console.log('3. /indit [név] - Videó indítása');
    console.log('4. /leallitas - Stream leállítása');
    console.log('5. /csatlakozas - Voice csatornához csatlakozás');
    console.log('6. /kilepes - Voice csatornából kilépés\n');
});



client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    
    if (interaction.channelId !== CONFIG.COMMAND_CHANNEL_ID) {
        return interaction.reply({
            content: '❌ Ez a parancs csak a kijelölt csatornában használható!',
            ephemeral: true
        });
    }

    const { commandName } = interaction;

    try {
        switch (commandName) {
            case 'lista':
                await handleListaCommand(interaction);
                break;
            case 'keres':
                await handleKeresCommand(interaction);
                break;
            case 'indit':
                await handleInditCommandImproved(interaction); 
                break;
            case 'leallitas':
                await handleLeallitasCommand(interaction);
                break;
            case 'info':
                await handleInfoCommand(interaction);
                break;
            case 'csatlakozas':
                await handleCsatlakozasCommand(interaction);
                break;
            case 'kilepes':
                await handleKilepesCommand(interaction);
                break;
            case 'status': 
                await handleStatusCommand(interaction);
                break;
            case 'tutorial': 
                await handleTutorialCommand(interaction);
                break;
            default:
                await interaction.reply({
                    content: '❌ Ismeretlen parancs!',
                    ephemeral: true
                });
        }
    } catch (error) {
        console.error('Parancs végrehajtási hiba:', error);
        await interaction.reply({
            content: '❌ Hiba történt a parancs végrehajtása során!',
            ephemeral: true
        });
    }
});


async function handleListaCommand(interaction) {
    const category = interaction.options.getString('kategoria');
    const folderPath = CONFIG.MEDIA_PATHS[category];
    
    if (!folderPath || !fs.existsSync(folderPath)) {
        return interaction.reply({
            content: `❌ A "${category}" mappa nem található: ${folderPath}`,
            ephemeral: true
        });
    }

    await interaction.deferReply();
    
    const mediaFiles = scanMediaFolder(folderPath);
    
    if (mediaFiles.length === 0) {
        return interaction.editReply('❌ Nem található médiafájl ebben a kategóriában.');
    }

   
    mediaFiles.sort((a, b) => a.title.localeCompare(b.title));
    
    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`📁 ${category.toUpperCase()} - ${mediaFiles.length} fájl`)
        .setDescription('Elérhető médiafájlok:')
        .setTimestamp();

 
    const maxFiles = Math.min(mediaFiles.length, 25);
    for (let i = 0; i < maxFiles; i++) {
        const file = mediaFiles[i];
        const sizeInMB = (file.size / (1024 * 1024)).toFixed(1);
        const icon = file.isVideo ? '🎬' : '🎵';
        
        embed.addFields({
            name: `${icon} ${file.title}`,
            value: `📄 ${file.name}\n💾 ${sizeInMB} MB`,
            inline: true
        });
    }
    
    if (mediaFiles.length > 25) {
        embed.setFooter({ text: `... és még ${mediaFiles.length - 25} fájl` });
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handleKeresCommand(interaction) {
    const query = interaction.options.getString('nev');
    const category = interaction.options.getString('kategoria');
    
    await interaction.deferReply();
    
    const results = searchMedia(query, category);
    
    if (results.length === 0) {
        return interaction.editReply(`❌ Nem található "${query}" nevű fájl.`);
    }

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(`🔍 Keresési eredmények: "${query}"`)
        .setDescription(`${results.length} találat:`)
        .setTimestamp();

    const maxResults = Math.min(results.length, 20);
    for (let i = 0; i < maxResults; i++) {
        const file = results[i];
        const sizeInMB = (file.size / (1024 * 1024)).toFixed(1);
        const icon = file.isVideo ? '🎬' : '🎵';
        
        embed.addFields({
            name: `${icon} ${file.title}`,
            value: `📂 ${file.category}\n📄 ${file.name}\n💾 ${sizeInMB} MB`,
            inline: true
        });
    }
    
    if (results.length > 20) {
        embed.setFooter({ text: `... és még ${results.length - 20} találat` });
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handleInditCommandImproved(interaction) {
    const query = interaction.options.getString('nev');
    
    await interaction.deferReply();
    
    try {
        const results = searchMedia(query);
        
        if (results.length === 0) {
            return interaction.editReply(`❌ Nem található "${query}" nevű videó.`);
        }

        const videoResults = results.filter(file => file.isVideo);
        
        if (videoResults.length === 0) {
            return interaction.editReply(`❌ Nem található "${query}" nevű videófájl.`);
        }

        const selectedVideo = videoResults[0];
        currentMediaPath = selectedVideo.path;
        
       
        if (!fs.existsSync(selectedVideo.path)) {
            return interaction.editReply(`❌ A videófájl nem elérhető: ${selectedVideo.path}`);
        }
        
        const embed = new EmbedBuilder()
            .setColor('#FF6B00')
            .setTitle('🚀 VIDEÓ STREAM INDÍTÁSA')
            .setDescription(`**${selectedVideo.title}** stream előkészítése...`)
            .addFields(
                { name: '📄 Fájl', value: selectedVideo.name, inline: true },
                { name: '📂 Kategória', value: selectedVideo.category, inline: true },
                { name: '💾 Méret', value: `${(selectedVideo.size / (1024 * 1024)).toFixed(1)} MB`, inline: true },
                { name: '⏳ Állapot', value: 'Böngésző indítása...', inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        
       
        const videoUrl = `http://localhost:${CONFIG.WEB_PORT}/player/${encodeURIComponent(selectedVideo.name)}`;
        const success = await startAutomaticScreenShare(
            videoUrl,
            CONFIG.DEFAULT_VOICE_CHANNEL_ID,
            CONFIG.GUILD_ID
        );
        
        if (success) {
            const successEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ STREAM ELINDÍTVA!')
                .setDescription('**📺 KÉSZ A STREAMELÉSHEZ!**')
                .addFields(
                    { name: '🎯 KÖVETKEZŐ LÉPÉS', value: '**OSZD MEG A KÉPERNYŐDET** a Discord voice csatornában!', inline: false },
                    { name: '🖥️ Böngésző', value: 'Automatikusan megnyílt kiosk módban', inline: true },
                    { name: '🔊 Voice', value: 'Bot csatlakozott a csatornához', inline: true },
                    { name: '⚡ Minőség', value: CONFIG.STREAM_QUALITY.toUpperCase(), inline: true },
                    { name: '📖 Útmutató', value: 'Használd a `/tutorial` parancsot részletes leírásért', inline: false }
                )
                .setFooter({ text: 'Tipp: Használj Discord overlay-t a könnyebb vezérléshez!' })
                .setTimestamp();
            
            await interaction.followUp({ embeds: [successEmbed] });
        } else {
            throw new Error('Stream indítás sikertelen');
        }
        
    } catch (error) {
        console.error('Videó indítási hiba:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ STREAM HIBA')
            .setDescription('Nem sikerült elindítani a streamet.')
            .addFields(
                { name: '🔧 Hiba', value: error.message || 'Ismeretlen hiba', inline: false },
                { name: '💡 Megoldás', value: '• Ellenőrizd a fájl elérhetőségét\n• Próbáld újra\n• Használd a `/status` parancsot', inline: false }
            )
            .setTimestamp();
        
        await interaction.followUp({ embeds: [errorEmbed] });
    }
}


async function handleLeallitasCommand(interaction) {
    await interaction.deferReply();
    
    await stopScreenShare();
    currentMediaPath = null;
    
    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🛑 STREAM LEÁLLÍTVA')
        .setDescription('A stream és voice connection leállítva.')
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

async function handleInfoCommand(interaction) {
    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🤖 Discord Media Streaming Bot')
        .setDescription('Fejlett médiaszerver automatikus screen sharing funkcióval')
        .addFields(
            { name: '📋 Elérhető parancsok', value: '`/lista` - Fájlok listázása\n`/keres` - Fájl keresése\n`/indit` - Videó indítása\n`/leallitas` - Stream leállítása\n`/csatlakozas` - Voice csatlakozás\n`/kilepes` - Voice kilépés', inline: false },
            { name: '🎬 Támogatott formátumok', value: 'Videó: MP4, MKV, AVI, MOV, WMV, FLV, WEBM\nAudió: MP3, FLAC, WAV, AAC, OGG, M4A', inline: false },
            { name: '⌨️ Billentyű vezérlés', value: 'Space: Play/Pause, ←→: Seek, ↑↓: Volume, F: Fullscreen, M: Mute, ESC: Controls', inline: false },
            { name: '🌐 Webszerver', value: `http://localhost:${CONFIG.WEB_PORT}`, inline: true },
            { name: '📁 Médiamappák', value: Object.entries(CONFIG.MEDIA_PATHS).map(([key, value]) => `${key}: ${value}`).join('\n'), inline: false }
        )
        .setFooter({ text: 'Created by Discord Media Bot v2.0' })
        .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
}

setInterval(async () => {
    
    if (streamingBrowser && streamingPage) {
        try {
            const isConnected = await streamingPage.evaluate(() => !document.hidden);
            if (!isConnected) {
                console.log('🧹 Böngésző kapcsolat elveszett, tisztítás...');
                await stopScreenShare();
            }
        } catch (error) {
            console.log('🧹 Böngésző hiba észlelve, tisztítás...');
            await stopScreenShare();
        }
    }
}, 30000);

async function handleCsatlakozasCommand(interaction) {
    const channel = interaction.options.getChannel('csatorna');
    
    await interaction.deferReply();
    
    let voiceChannelId;
    let channelName;
    
    if (channel) {
        if (channel.type !== 2) {
            return interaction.editReply({
                content: '❌ A megadott csatorna nem voice csatorna!',
                ephemeral: true
            });
        }
        voiceChannelId = channel.id;
        channelName = channel.name;
    } else {
        
        voiceChannelId = await findAvailableVoiceChannel(CONFIG.GUILD_ID);
        if (!voiceChannelId) {
            return interaction.editReply({
                content: '❌ Nincs elérhető voice csatorna a szerveren!',
                ephemeral: true
            });
        }
        
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        const foundChannel = guild.channels.cache.get(voiceChannelId);
        channelName = foundChannel ? foundChannel.name : 'Ismeretlen csatorna';
    }
    
    const connection = await joinVoiceChannelById(voiceChannelId, CONFIG.GUILD_ID);
    
    if (connection) {
        currentVoiceConnection = connection;
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('🔊 VOICE CSATLAKOZÁS')
            .setDescription(`✅ Sikeresen csatlakoztam a voice csatornához!`)
            .addFields(
                { name: '📢 Csatorna', value: channelName, inline: true },
                { name: '🆔 Csatorna ID', value: voiceChannelId, inline: true }
            )
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
    } else {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ CSATLAKOZÁSI HIBA')
            .setDescription('Nem sikerült csatlakozni a voice csatornához.')
            .addFields(
                { name: '🔧 Lehetséges okok', value: '• Nincs jogosultság a csatornához\n• A csatorna nem létezik\n• Bot már másik csatornában van', inline: false }
            )
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
    }
}

async function handleKilepesCommand(interaction) {
    await interaction.deferReply();
    
    await leaveVoiceChannel();
    
    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('🚪 VOICE KILÉPÉS')
        .setDescription('✅ Elhagytam a voice csatornát.')
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}


client.login(CONFIG.DISCORD_TOKEN).catch(error => {
    console.error('❌ Bot bejelentkezési hiba:', error);
    console.log('🔧 Ellenőrizd a DISCORD_TOKEN-t a CONFIG részben!');
});


process.on('unhandledRejection', error => {
    console.error('Kezeletlen Promise elutasítás:', error);
});

process.on('uncaughtException', error => {
    console.error('Kezeletlen kivétel:', error);
});


process.on('SIGINT', async () => {
    console.log('\n🛑 Bot leállítása...');
    await stopScreenShare();
    await leaveVoiceChannel();
    client.destroy();
    process.exit(0);
});

console.log('🚀 Discord Media Streaming Bot betöltve!');
console.log('⚠️  FONTOS: Állítsd be a DISCORD_TOKEN-t a CONFIG részben!');
console.log('📁 Ellenőrizd a médiamappa útvonalakat is!');