// Wake-on-LAN connector. There is no HTTP endpoint to poll: the service is a
// configured MAC address plus an optional broadcast address, and the "wake"
// action sends a magic packet over UDP. Useful as a dashboard quick action for
// NAS/media PCs that are normally powered off.
import dgram from 'node:dgram';

const lastWake = new Map(); // service id -> timestamp

function normalizeMac(value) {
  const raw = String(value || '').trim();
  const hex = raw.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return '';
  return hex.match(/.{2}/g).map((part) => part.toUpperCase()).join(':');
}

function macBytes(mac) {
  return Buffer.from(mac.replace(/:/g, ''), 'hex');
}

function magicPacket(mac) {
  const target = macBytes(mac);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => target)]);
}

function sendPacket(mac, broadcast, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = magicPacket(mac);
    socket.once('error', (err) => {
      try { socket.close(); } catch { /* ignore */ }
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, broadcast, (err) => {
        try { socket.close(); } catch { /* ignore */ }
        if (err) reject(err); else resolve();
      });
    });
  });
}

export default {
  reset(id) {
    lastWake.delete(id);
  },

  async test(ctx) {
    const mac = normalizeMac(ctx.extra?.mac);
    if (!mac) return { ok: false, message: 'Enter the MAC address (AA:BB:CC:DD:EE:FF)' };
    return { ok: true, message: `Wake-on-LAN ready for ${mac}` };
  },

  async poll(ctx) {
    const mac = normalizeMac(ctx.extra?.mac);
    const broadcast = String(ctx.extra?.broadcast || '255.255.255.255').trim();
    const port = Math.max(1, Math.min(65535, Number(ctx.extra?.port) || 9));
    const woke = lastWake.get(ctx.id);
    return {
      stats: [
        { label: 'MAC', value: mac || 'not configured' },
        { label: 'Broadcast', value: `${broadcast}:${port}` },
        { label: 'Last wake', value: woke ? new Date(woke).toLocaleTimeString() : 'never' },
      ],
      charts: {},
    };
  },

  async action(ctx, { action } = {}) {
    if (action !== 'wake') return { ok: false, message: `Unknown action "${action}"` };
    const mac = normalizeMac(ctx.extra?.mac);
    if (!mac) return { ok: false, message: 'No MAC address configured' };
    const broadcast = String(ctx.extra?.broadcast || '255.255.255.255').trim();
    const port = Math.max(1, Math.min(65535, Number(ctx.extra?.port) || 9));
    try {
      await sendPacket(mac, broadcast, port);
      lastWake.set(ctx.id, Date.now());
      return { ok: true, message: `Magic packet sent to ${mac}` };
    } catch (err) {
      return { ok: false, message: `Could not send magic packet: ${err.message}` };
    }
  },
};
