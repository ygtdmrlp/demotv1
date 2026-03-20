const express = require('express');
const axios = require('axios');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const parser = require('iptv-playlist-parser');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// M3U URL Parser Endpoint
app.post('/api/playlist/url', async (req, res) => {
  const { url } = req.body;
  try {
    const response = await axios.get(url, { timeout: 10000 });
    let result = parser.parse(response.data);
    
    // Fallback: If no items found but it's a valid M3U8/TS stream link
    if ((!result.items || result.items.length === 0) && (url.toLowerCase().endsWith('.m3u8') || url.toLowerCase().endsWith('.ts'))) {
      const fileName = url.split('/').pop().split('?')[0] || 'Tekil Kanal';
      result = {
        header: { name: 'Tekil Kanal Listesi' },
        items: [{
          name: fileName,
          url: url,
          tvg: { logo: '' },
          group: { title: 'Tekil Kanallar' }
        }]
      };
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching M3U URL:', error.message);
    res.status(500).json({ error: 'Playlist URL fetching failed.' });
  }
});

// M3U File Upload Endpoint
app.post('/api/playlist/file', upload.single('playlist'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  try {
    const filePath = req.file.path;
    const data = fs.readFileSync(filePath, 'utf-8');
    const result = parser.parse(data);
    fs.unlinkSync(filePath); // Delete file after parsing
    res.json(result);
  } catch (error) {
    console.error('Error parsing M3U file:', error.message);
    res.status(500).json({ error: 'Playlist parsing failed.' });
  }
});

// Xtream Codes API Login
app.post('/api/xtream/login', async (req, res) => {
  const { server, username, password } = req.body;
  try {
    const loginUrl = `${server}/player_api.php?username=${username}&password=${password}`;
    const response = await axios.get(loginUrl, { timeout: 10000 });
    if (response.data.user_info && response.data.user_info.auth === 1) {
      res.json(response.data);
    } else {
      res.status(401).json({ error: 'Authentication failed.' });
    }
  } catch (error) {
    console.error('Xtream Login Error:', error.message);
    res.status(500).json({ error: 'Xtream API connection failed.' });
  }
});

// Xtream Codes - Get Live/VOD/Series
app.post('/api/xtream/data', async (req, res) => {
  const { server, username, password, action } = req.body;
  try {
    const url = `${server}/player_api.php?username=${username}&password=${password}&action=${action}`;
    const response = await axios.get(url, { timeout: 15000 });
    res.json(response.data);
  } catch (error) {
    console.error(`Xtream ${action} Error:`, error.message);
    res.status(500).json({ error: `Failed to fetch ${action} data.` });
  }
});

// Xtream Codes - Get EPG
app.post('/api/xtream/epg', async (req, res) => {
  const { server, username, password, stream_id } = req.body;
  try {
    const url = `${server}/player_api.php?username=${username}&password=${password}&action=get_short_epg&stream_id=${stream_id}`;
    const response = await axios.get(url, { timeout: 5000 });
    res.json(response.data);
  } catch (error) {
    console.error('Xtream EPG Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch EPG.' });
  }
});

// Proxy Endpoint for CORS Bypass
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL is required');

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // Copy original content-type and other useful headers
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/vnd.apple.mpegurl');
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    
    response.data.pipe(res);
  } catch (error) {
    console.error('Proxy Error:', error.message);
    res.status(500).send('Proxy failed to fetch the stream.');
  }
});

app.listen(port, () => {
  console.log(`IPTV Player server running at http://localhost:${port}`);
});
