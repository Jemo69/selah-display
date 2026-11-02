import { networkInterfaces } from 'os';
import dgram from 'dgram';

function getActiveIP() {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');

        socket.connect(80, '8.8.8.8', () => {
            const { address } = socket.address();
            socket.close();
            resolve(address);
        });

        socket.on('error', () => resolve('localhost'));
    });
}


export async function getLocalIPAddress() {
    const activeIP = await getActiveIP();
    const nets = networkInterfaces();

    if (!activeIP || activeIP === '0.0.0.0') {
        return 'localhost';
    }

    for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
            if (
                net.family === 'IPv4' &&
                !net.internal &&
                net.address === activeIP
            ) {
                return net.address;
            }
        }
    }

    return activeIP;
}

// Single source of truth for this instance's backend origin. The backend
// fork inherits process.env (see main/backend.js), so PORT is authoritative;
// default 4000 preserves every existing install, shortcut, and QR payload.
export function backendBaseUrl() {
    const raw = Number(process.env.PORT);
    const port = Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 4000;
    return `http://127.0.0.1:${port}`;
}

const isTailscaleAddress = (addr = '') => {
    const parts = String(addr).split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    return a === 100 && b >= 64 && b <= 127;
};

// Every reachable LAN + tailnet IPv4, with the active route first.
// The mobile QR dialog shows all of these so a phone on Tailscale
// (100.x / <name>.ts.net) can connect without typing an IP.
export function getAllLocalIPAddresses() {
    const nets = networkInterfaces();
    const seen = new Set();
    const lan = [];
    const tailnet = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
            if (net?.family !== 'IPv4' || net.internal || !net.address) continue;
            if (seen.has(net.address)) continue;
            seen.add(net.address);
            const entry = { address: net.address, interface: name, tailscale: isTailscaleAddress(net.address) };
            if (entry.tailscale) tailnet.push(entry);
            else lan.push(entry);
        }
    }
    return { lan, tailnet, all: [...lan, ...tailnet] };
}
