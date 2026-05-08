const fs = require('fs');
const path = require('path');
const https = require('https');

const VTRACER_BIN = path.join(__dirname, 'vtracer');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

async function install() {
  if (fs.existsSync(VTRACER_BIN)) {
    console.log('VTracer already installed');
    return;
  }

  const platform = process.platform;
  const arch = process.arch;
  
  let url;
  if (platform === 'linux' && arch === 'x64') {
    url = 'https://github.com/visioncortex/vtracer/releases/download/0.6.4/vtracer-linux-x64';
  } else if (platform === 'darwin' && arch === 'x64') {
    url = 'https://github.com/visioncortex/vtracer/releases/download/0.6.4/vtracer-macos-x64';
  } else if (platform === 'win32') {
    url = 'https://github.com/visioncortex/vtracer/releases/download/0.6.4/vtracer-windows-x64.exe';
  } else {
    console.log(`Platform ${platform}-${arch} not supported for VTracer, will use fallback`);
    return;
  }

  console.log(`Downloading VTracer from ${url}...`);
  try {
    await download(url, VTRACER_BIN);
    fs.chmodSync(VTRACER_BIN, 0o755);
    console.log('VTracer installed successfully');
  } catch (e) {
    console.log(`VTracer download failed: ${e.message}, will use fallback`);
  }
}

install().catch(() => {});
