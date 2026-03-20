// State Management
let state = {
    playlist: [],
    sources: JSON.parse(localStorage.getItem('playlistSources') || '[]'), // Array of {type, url, credentials, name}
    filteredPlaylist: [],
    categories: [],
    currentType: 'live', 
    currentCategory: 'all',
    currentChannel: null,
    favorites: JSON.parse(localStorage.getItem('favorites') || '[]'),
    xtreamInfo: null,
    searchQuery: '',
    hls: null,
    isPlaying: false,
    isMuted: false,
    lastVolume: 1,
    lastChannelId: localStorage.getItem('lastChannelId'),
    settings: JSON.parse(localStorage.getItem('appSettings') || JSON.stringify({
        lowLatency: false,
        autoPlay: true,
        compactMode: false,
        useProxy: true
    }))
};

// IndexedDB Setup for Playlist Caching
const DB_NAME = 'IPTV_PLAYER_DB';
const DB_VERSION = 1;
const STORE_NAME = 'playlist_cache';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function savePlaylistToDB(items) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(items, 'current_playlist');
        return tx.complete;
    } catch (err) {
        console.error('Failed to save playlist to DB:', err);
    }
}

async function loadPlaylistFromDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        return new Promise((resolve) => {
            const request = store.get('current_playlist');
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
        });
    } catch (err) {
        console.error('Failed to load playlist from DB:', err);
        return [];
    }
}

async function clearDB() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
    } catch (err) {
        console.error('Failed to clear DB:', err);
    }
}

// Initialize Lucide Icons
lucide.createIcons();

// --- Setup Screen Logic ---
function switchSetupTab(tabId) {
    document.querySelectorAll('.setup-tab').forEach(btn => {
        btn.classList.remove('border-red-600', 'text-red-600');
        btn.classList.add('border-transparent', 'text-gray-400');
    });
    event.target.classList.add('border-red-600', 'text-red-600');
    event.target.classList.remove('border-transparent', 'text-gray-400');

    document.querySelectorAll('.setup-form').forEach(form => form.classList.add('hidden'));
    document.getElementById(`${tabId}-form`).classList.remove('hidden');
}

// M3U URL Loading
async function loadM3UUrl() {
    const url = document.getElementById('m3u-url-input').value;
    const append = document.getElementById('append-m3u-url')?.checked || false;
    if (!url) return showError('Lütfen bir URL girin.');
    
    showLoading(true);
    try {
        const response = await fetch('/api/playlist/url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        
        processPlaylist(data.items, !append);
        saveSession({ type: 'm3u-url', url, append });
        enterApp();
    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// M3U File Upload
async function uploadM3UFile() {
    const fileInput = document.getElementById('m3u-file-input');
    const append = document.getElementById('append-file')?.checked || false;
    if (!fileInput.files[0]) return showError('Lütfen bir dosya seçin.');
    
    const formData = new FormData();
    formData.append('playlist', fileInput.files[0]);
    
    showLoading(true);
    try {
        const response = await fetch('/api/playlist/file', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        
        processPlaylist(data.items, !append);
        saveSession({ type: 'm3u-file', name: fileInput.files[0].name, append });
        enterApp();
    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

// Xtream Login
async function loginXtream() {
    const server = document.getElementById('xtream-server').value;
    const username = document.getElementById('xtream-user').value;
    const password = document.getElementById('xtream-pass').value;
    const append = document.getElementById('append-xtream')?.checked || false;
    
    if (!server || !username || !password) return showError('Lütfen tüm alanları doldurun.');
    
    showLoading(true);
    try {
        const response = await fetch('/api/xtream/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server, username, password })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        
        state.xtreamInfo = { server, username, password };
        saveSession({ type: 'xtream', ...state.xtreamInfo, append });
        
        // Load initial live channels
        await loadXtreamData('get_live_streams', !append);
        enterApp();
    } catch (err) {
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

async function loadXtreamData(action, clearState = true) {
    showLoading(true);
    try {
        const response = await fetch('/api/xtream/data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...state.xtreamInfo, action })
        });
        const data = await response.json();
        
        // Map Xtream data to common format
        const items = data.map(item => ({
            name: item.name,
            tvg: { logo: item.stream_icon || item.cover },
            group: { title: item.category_id }, // Xtream uses category_id, we'll map names later if needed
            url: `${state.xtreamInfo.server}/${action === 'get_live_streams' ? 'live' : action === 'get_vod_streams' ? 'movie' : 'series'}/${state.xtreamInfo.username}/${state.xtreamInfo.password}/${item.stream_id || item.series_id}.${action === 'get_live_streams' ? 'm3u8' : 'mp4'}`,
            id: item.stream_id || item.series_id,
            type: action === 'get_live_streams' ? 'live' : action === 'get_vod_streams' ? 'vod' : 'series'
        }));
        
        processPlaylist(items, clearState);
    } catch (err) {
        console.error('Xtream data load error:', err);
    } finally {
        showLoading(false);
    }
}

// --- App Logic ---

function processPlaylist(items, clearState = true) {
    if (clearState) state.playlist = items;
    else state.playlist = [...state.playlist, ...items];
    
    // Save to IndexedDB for F5 persistence
    savePlaylistToDB(state.playlist);
    
    // Extract categories
    const categorySet = new Set();
    items.forEach(item => {
        if (item.group && item.group.title) categorySet.add(item.group.title);
    });
    state.categories = Array.from(categorySet).sort();
    
    renderCategories();
    filterItems();
}

function renderCategories() {
    const container = document.getElementById('category-list');
    container.innerHTML = `
        <button id="cat-all" onclick="filterCategory('all')" class="cat-btn w-full text-left px-3 py-2 rounded-lg text-sm transition-all truncate ${state.currentCategory === 'all' ? 'text-red-600 bg-[#1e1e1e]' : 'text-gray-400 hover:bg-[#1e1e1e]'}">
            Tümü
        </button>
    `;
    
    state.categories.forEach((cat, index) => {
        const btn = document.createElement('button');
        const isActive = state.currentCategory === cat;
        btn.id = `cat-${index}`;
        btn.className = `cat-btn w-full text-left px-3 py-2 rounded-lg text-sm transition-all truncate ${isActive ? 'text-red-600 bg-[#1e1e1e]' : 'text-gray-400 hover:bg-[#1e1e1e]'}`;
        btn.textContent = cat;
        btn.onclick = (e) => filterCategory(cat, e.currentTarget);
        container.appendChild(btn);
    });
}

function filterType(type) {
    state.currentType = type;
    state.currentCategory = 'all';
    
    // Update Sidebar UI
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('text-red-600', 'bg-[#1e1e1e]');
        btn.classList.add('text-gray-400');
    });
    
    // Use currentTarget for better event handling
    if (event && event.currentTarget) {
        event.currentTarget.classList.add('text-red-600', 'bg-[#1e1e1e]');
        event.currentTarget.classList.remove('text-gray-400');
    }

    if (window.innerWidth < 768) toggleSidebar(); // Close sidebar on mobile after selection

    if (state.xtreamInfo) {
        const actionMap = { live: 'get_live_streams', vod: 'get_vod_streams', series: 'get_series' };
        if (type !== 'favorites') loadXtreamData(actionMap[type]);
        else filterItems();
    } else {
        filterItems();
    }
}

function filterCategory(cat, element) {
    state.currentCategory = cat;
    
    // Update UI
    document.querySelectorAll('.cat-btn').forEach(btn => {
        btn.classList.remove('text-red-600', 'bg-[#1e1e1e]');
        btn.classList.add('text-gray-400');
    });
    
    if (element) {
        element.classList.add('text-red-600', 'bg-[#1e1e1e]');
        element.classList.remove('text-gray-400');
    } else {
        // Fallback for direct calls
        document.getElementById('cat-all')?.classList.add('text-red-600', 'bg-[#1e1e1e]');
    }
    
    if (window.innerWidth < 768) toggleSidebar(); // Close sidebar on mobile after selection
    filterItems();
}

function filterItems() {
    let filtered = state.playlist;
    
    // Type Filter
    if (state.currentType === 'favorites') {
        filtered = state.playlist.filter(item => state.favorites.includes(item.id || item.url));
    } else if (!state.xtreamInfo) {
        // For M3U, we try to guess type or just show all
    }

    // Category Filter
    if (state.currentCategory !== 'all') {
        filtered = filtered.filter(item => item.group && item.group.title === state.currentCategory);
    }

    // Search Filter
    if (state.searchQuery) {
        const query = state.searchQuery.toLowerCase();
        filtered = filtered.filter(item => item.name.toLowerCase().includes(query));
    }

    state.filteredPlaylist = filtered;
    renderGrid();
}

function renderGrid() {
    const grid = document.getElementById('items-grid');
    const title = document.getElementById('category-title');
    const count = document.getElementById('item-count');
    
    grid.innerHTML = '';
    
    // Apply compact mode class
    if (state.settings.compactMode) {
        grid.className = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12 gap-2';
    } else {
        grid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4';
    }

    title.textContent = state.currentCategory === 'all' ? 
        (state.currentType === 'live' ? 'Canlı TV' : state.currentType === 'vod' ? 'Filmler' : 'Diziler') : 
        state.currentCategory;
    count.textContent = `${state.filteredPlaylist.length} öğe bulundu`;

    state.filteredPlaylist.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = 'channel-card group cursor-pointer space-y-2';
        card.onclick = () => playChannel(item);
        
        const logo = item.tvg && item.tvg.logo ? item.tvg.logo : 'https://via.placeholder.com/300x450/1e1e1e/ffffff?text=' + encodeURIComponent(item.name);
        
        card.innerHTML = `
            <div class="relative aspect-[2/3] md:aspect-video rounded-xl overflow-hidden bg-[#1e1e1e] shadow-lg">
                <img src="${logo}" alt="${item.name}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" loading="lazy">
                <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div class="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center shadow-xl">
                        <i data-lucide="play" class="w-6 h-6 text-white fill-current ml-1"></i>
                    </div>
                </div>
                ${state.favorites.includes(item.id || item.url) ? '<div class="absolute top-2 right-2 text-red-600"><i data-lucide="heart" class="w-4 h-4 fill-current"></i></div>' : ''}
            </div>
            <h3 class="text-sm font-semibold line-clamp-2 px-1 group-hover:text-red-500 transition-colors">${item.name}</h3>
        `;
        grid.appendChild(card);
    });
    lucide.createIcons();
}

// --- Player Logic ---

function playChannel(item) {
    state.currentChannel = item;
    const overlay = document.getElementById('player-overlay');
    const video = document.getElementById('video-player');
    const title = document.getElementById('player-title');
    const epg = document.getElementById('player-epg');
    const favBtn = document.getElementById('player-fav-btn');

    overlay.classList.remove('hidden');
    title.textContent = item.name;
    epg.textContent = 'Yayın bilgisi yok';
    
    // Update Fav Btn
    updateFavBtnUI();

    // CORS Proxy Logic
    let streamUrl = item.url;
    if (state.settings.useProxy) {
        streamUrl = `/api/proxy?url=${encodeURIComponent(item.url)}`;
    }

    if (Hls.isSupported()) {
        if (state.hls) state.hls.destroy();
        const hlsConfig = {
            capLevelToPlayerSize: true,
            startLevel: -1,
            maxBufferLength: state.settings.lowLatency ? 10 : 30,
            liveSyncDurationCount: state.settings.lowLatency ? 1 : 3,
            enableLowLatencyMode: state.settings.lowLatency
        };
        state.hls = new Hls(hlsConfig);
        state.hls.loadSource(streamUrl);
        state.hls.attachMedia(video);
        state.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (state.settings.autoPlay) {
                video.play();
                state.isPlaying = true;
                updatePlayBtn();
            }
            updateQualityLevels();
        });
        
        state.hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        state.hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        state.hls.recoverMediaError();
                        break;
                    default:
                        state.hls.destroy();
                        break;
                }
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = item.url;
        video.addEventListener('loadedmetadata', () => {
            video.play();
            state.isPlaying = true;
            updatePlayBtn();
        });
    }

    // Save last watched
    localStorage.setItem('lastChannelId', item.id || item.url);
    
    // Fetch EPG if Xtream
    if (state.xtreamInfo && item.id) fetchEPG(item.id);
}

async function fetchEPG(streamId) {
    try {
        const response = await fetch('/api/xtream/epg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...state.xtreamInfo, stream_id: streamId })
        });
        const data = await response.json();
        if (data.epg_listings && data.epg_listings.length > 0) {
            const current = data.epg_listings[0];
            document.getElementById('player-epg').textContent = `${atob(current.title)} (${current.start.split(' ')[1].slice(0,5)} - ${current.end.split(' ')[1].slice(0,5)})`;
        }
    } catch (err) {
        console.error('EPG error:', err);
    }
}

function closePlayer() {
    const video = document.getElementById('video-player');
    video.pause();
    if (state.hls) state.hls.stopLoad();
    document.getElementById('player-overlay').classList.add('hidden');
    state.isPlaying = false;
}

function togglePlay() {
    const video = document.getElementById('video-player');
    if (video.paused) {
        video.play();
        state.isPlaying = true;
    } else {
        video.pause();
        state.isPlaying = false;
    }
    updatePlayBtn();
}

function updatePlayBtn() {
    const btn = document.getElementById('play-btn');
    btn.innerHTML = state.isPlaying ? 
        '<i data-lucide="pause" class="w-8 h-8 fill-current"></i>' : 
        '<i data-lucide="play" class="w-8 h-8 fill-current"></i>';
    lucide.createIcons();
}

function toggleMute() {
    const video = document.getElementById('video-player');
    const slider = document.getElementById('volume-slider');
    state.isMuted = !state.isMuted;
    video.muted = state.isMuted;
    
    if (state.isMuted) {
        state.lastVolume = slider.value;
        slider.value = 0;
    } else {
        slider.value = state.lastVolume;
    }
    updateMuteBtn();
}

function updateMuteBtn() {
    const btn = document.getElementById('mute-btn');
    btn.innerHTML = state.isMuted ? 
        '<i data-lucide="volume-x" class="w-6 h-6"></i>' : 
        '<i data-lucide="volume-2" class="w-6 h-6"></i>';
    lucide.createIcons();
}

document.getElementById('volume-slider').addEventListener('input', (e) => {
    const video = document.getElementById('video-player');
    video.volume = e.target.value;
    state.isMuted = e.target.value == 0;
    video.muted = state.isMuted;
    updateMuteBtn();
});

function toggleFullscreen() {
    const overlay = document.getElementById('player-overlay');
    if (!document.fullscreenElement) {
        overlay.requestFullscreen().catch(err => console.error(err));
    } else {
        document.exitFullscreen();
    }
}

function updateQualityLevels() {
    const selector = document.getElementById('quality-selector');
    selector.innerHTML = '<option value="-1">Auto</option>';
    
    if (state.hls && state.hls.levels) {
        state.hls.levels.forEach((level, index) => {
            const opt = document.createElement('option');
            opt.value = index;
            opt.textContent = `${level.height}p`;
            selector.appendChild(opt);
        });
    }
}

function changeQuality(index) {
    if (state.hls) {
        state.hls.currentLevel = parseInt(index);
    }
}

function toggleFavoriteCurrent() {
    if (!state.currentChannel) return;
    const id = state.currentChannel.id || state.currentChannel.url;
    const idx = state.favorites.indexOf(id);
    
    if (idx === -1) {
        state.favorites.push(id);
    } else {
        state.favorites.splice(idx, 1);
    }
    
    localStorage.setItem('favorites', JSON.stringify(state.favorites));
    updateFavBtnUI();
    filterItems();
}

function updateFavBtnUI() {
    const btn = document.getElementById('player-fav-btn');
    const id = state.currentChannel.id || state.currentChannel.url;
    btn.innerHTML = state.favorites.includes(id) ? 
        '<i data-lucide="heart" class="w-6 h-6 text-red-600 fill-current"></i>' : 
        '<i data-lucide="heart" class="w-6 h-6"></i>';
    lucide.createIcons();
}

function nextChannel() {
    const idx = state.filteredPlaylist.findIndex(item => (item.id || item.url) === (state.currentChannel.id || state.currentChannel.url));
    if (idx < state.filteredPlaylist.length - 1) {
        playChannel(state.filteredPlaylist[idx + 1]);
    }
}

function prevChannel() {
    const idx = state.filteredPlaylist.findIndex(item => (item.id || item.url) === (state.currentChannel.id || state.currentChannel.url));
    if (idx > 0) {
        playChannel(state.filteredPlaylist[idx - 1]);
    }
}

// --- Utilities ---

function showLoading(show) {
    document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

function showError(msg) {
    const errEl = document.getElementById('setup-error');
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    setTimeout(() => errEl.classList.add('hidden'), 5000);
}

function enterApp() {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
}

function logout() {
    localStorage.removeItem('session');
    location.reload();
}

function clearPlaylist() {
    if (confirm('Tüm playlist verilerini temizlemek ve yeni bir tane eklemek istediğinizden emin misiniz?')) {
        localStorage.removeItem('session');
        clearDB(); // Clear IndexedDB
        state.playlist = [];
        state.filteredPlaylist = [];
        state.categories = [];
        state.xtreamInfo = null;
        
        // Return to setup
        document.getElementById('main-app').classList.add('hidden');
        document.getElementById('setup-screen').classList.remove('hidden');
        
        // Reset forms
        document.getElementById('m3u-url-input').value = '';
        document.getElementById('xtream-server').value = '';
        document.getElementById('xtream-user').value = '';
        document.getElementById('xtream-pass').value = '';
        document.getElementById('m3u-file-input').value = '';
        document.getElementById('file-name-display').textContent = '';
    }
}

async function refreshPlaylist() {
    const session = JSON.parse(localStorage.getItem('session'));
    if (!session) return;
    
    if (session.type === 'm3u-file') {
        alert('Dosya ile yüklenen playlistler otomatik yenilenemez. Lütfen dosyayı tekrar yükleyin.');
        return;
    }
    
    showLoading(true);
    try {
        if (session.type === 'm3u-url') {
            document.getElementById('m3u-url-input').value = session.url;
            await loadM3UUrl();
        } else if (session.type === 'xtream') {
            state.xtreamInfo = session;
            await loadXtreamData('get_live_streams', !session.append);
        }
    } catch (err) {
        showError('Yenileme hatası: ' + err.message);
    } finally {
        showLoading(false);
    }
}

function toggleSettings() {
    const modal = document.getElementById('settings-modal');
    modal.classList.toggle('hidden');
    
    // Sync UI with state when opening
    if (!modal.classList.contains('hidden')) {
        document.getElementById('setting-low-latency').checked = state.settings.lowLatency;
        document.getElementById('setting-auto-play').checked = state.settings.autoPlay;
        document.getElementById('setting-compact-mode').checked = state.settings.compactMode;
        document.getElementById('setting-use-proxy').checked = state.settings.useProxy;
    }
}

function updateSetting(key, value) {
    state.settings[key] = value;
    localStorage.setItem('appSettings', JSON.stringify(state.settings));
    
    // Immediate effects
    if (key === 'compactMode') renderGrid();
}

function saveSession(data) {
    localStorage.setItem('session', JSON.stringify(data));
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    
    if (window.innerWidth < 768) {
        sidebar.classList.toggle('show');
        overlay.classList.toggle('show');
    } else {
        sidebar.classList.toggle('hidden');
        sidebar.classList.toggle('flex');
    }
}

// Search Logic
document.getElementById('search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    filterItems();
});

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('SW Registered'))
            .catch(err => console.log('SW Registration failed: ', err));
    });
}

// M3U File Input Display
document.getElementById('m3u-file-input').addEventListener('change', (e) => {
    const name = e.target.files[0] ? e.target.files[0].name : '';
    document.getElementById('file-name-display').textContent = name;
});

// Auto-login on startup
window.addEventListener('DOMContentLoaded', async () => {
    // Initial UI sync for settings
    document.getElementById('setting-low-latency').checked = state.settings.lowLatency;
    document.getElementById('setting-auto-play').checked = state.settings.autoPlay;
    document.getElementById('setting-compact-mode').checked = state.settings.compactMode;
    document.getElementById('setting-use-proxy').checked = state.settings.useProxy;

    // 1. Try to load cached playlist from IndexedDB for instant UI (F5 Fix)
    const cachedItems = await loadPlaylistFromDB();
    if (cachedItems && cachedItems.length > 0) {
        processPlaylist(cachedItems, true);
        enterApp();
        return; // Don't re-fetch on every refresh, use cached data
    }

    // 2. If no cache, check for session to auto-load
    const session = JSON.parse(localStorage.getItem('session'));
    if (session) {
        if (session.type === 'm3u-file') {
            // Can't re-fetch a file without user action, so if no cache, just return to setup
            localStorage.removeItem('session');
            return;
        }

        showLoading(true);
        try {
            if (session.type === 'm3u-url') {
                document.getElementById('m3u-url-input').value = session.url;
                await loadM3UUrl();
            } else if (session.type === 'xtream') {
                state.xtreamInfo = session;
                await loadXtreamData('get_live_streams', !session.append);
                enterApp();
            }
        } catch (err) {
            console.error('Initial auto-load failed:', err);
            localStorage.removeItem('session');
        } finally {
            showLoading(false);
        }
    }
});
