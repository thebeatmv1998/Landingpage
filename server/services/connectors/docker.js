// Docker — container states via the Docker socket (dockerode).
import { bundledIconFor } from '../registry.js';

async function getClient(ctx) {
  let Docker;
  try {
    Docker = (await import('dockerode')).default;
  } catch {
    throw new Error('dockerode package is not installed');
  }
  const socketPath = ctx.extra.socketPath
    || (process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : '/var/run/docker.sock');
  return new Docker({ socketPath });
}

function shortStatus(state, statusStr) {
  if (state === 'running') return statusStr.replace(/^Up\s*/i, 'Up ') || 'running';
  return statusStr || state;
}

export default {
  async test(ctx) {
    try {
      const docker = await getClient(ctx);
      const list = await docker.listContainers({ all: true });
      return { ok: true, message: `Docker reachable — ${list.length} containers` };
    } catch (err) {
      return { ok: false, message: 'Docker socket not reachable: ' + err.message };
    }
  },

  // Lifecycle actions for the Docker socket (admin-only at the route level).
  async action(ctx, { action, value } = {}) {
    if (!value) return { ok: false, message: 'Missing container id' };
    try {
      const docker = await getClient(ctx);
      const container = docker.getContainer(String(value));
      if (action === 'start') await container.start();
      else if (action === 'stop') await container.stop({ t: 10 });
      else if (action === 'restart') await container.restart({ t: 10 });
      else return { ok: false, message: `Unknown action "${action}"` };
      const label = { start: 'started', stop: 'stopped', restart: 'restarted' }[action];
      return { ok: true, message: `Container ${label}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const docker = await getClient(ctx);
    const list = await docker.listContainers({ all: true });
    const containers = list.map((c) => {
      const name = (c.Names?.[0] || '/unknown').replace(/^\//, '');
      // Unraid templates put the icon URL in a container label.
      const labelIcon = (c.Labels && c.Labels['net.unraid.docker.icon']) || '';
      const bundled = bundledIconFor(name, c.Image);
      return {
        id: c.Id.slice(0, 12),
        name,
        image: c.Image,
        state: c.State,
        status: shortStatus(c.State, c.Status),
        // If the template points at a dead/blocked URL, the UI retries with
        // the bundled icon instead of falling back to the generic cube.
        icon: labelIcon || bundled,
        iconFallback: labelIcon ? bundled : '',
      };
    });
    const running = containers.filter((c) => c.state === 'running').length;
    const stopped = containers.length - running;
    const unhealthy = containers.filter((c) => c.state === 'unhealthy' || /unhealthy/i.test(c.status)).length;

    const stats = [
      { label: 'Containers', value: containers.length },
      { label: 'Running', value: running, emphasis: running > 0, tone: running > 0 ? 'good' : undefined },
      { label: 'Stopped', value: stopped, emphasis: stopped > 0, tone: stopped > 0 ? 'bad' : undefined },
    ];
    if (unhealthy) stats.push({ label: 'Unhealthy', value: unhealthy, tone: 'bad' });

    return {
      stats,
      containers,
      charts: {
        docker: { running, stopped, unhealthy },
      },
    };
  },
};
