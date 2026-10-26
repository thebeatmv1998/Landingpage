# Security Policy

## Supported versions

Security fixes are provided for the latest published release and the current
`master` branch. Older releases are not supported; upgrade to the latest release
before reporting a deployment-specific issue.

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting**:

<https://github.com/thebeatmv1998/Landingpage/security/advisories/new>

Do not open a public issue for a suspected vulnerability. Include:

- HomeDeck version and deployment type (Docker/Unraid/bare Node),
- affected endpoint or component,
- reproduction steps or a proof of concept,
- impact and any relevant configuration.

Please do not include real credentials, device tokens, database dumps or personal
data. The maintainer will acknowledge a report as soon as practical and coordinate
disclosure after a fix is available.

## Deployment hardening

- Serve HomeDeck behind HTTPS; set `PUBLIC_URL` and `SECURE_COOKIES=1`.
- Do not expose the Docker socket to the container unless it is behind a filtering
  socket proxy. A Docker socket is effectively host-root access.
- Keep the `data/` directory private (0700) and back up the database together with
  the `.secret` and release-keystore material in a secure location.
- Use a strong administrator passphrase and enable TOTP for administrator accounts.
- Keep Node.js, npm dependencies and the container base image up to date.

## Scope

The project is a self-hosted dashboard. Reports about third-party services that
HomeDeck merely integrates with are out of scope unless HomeDeck itself introduces
the vulnerability (for example, through its proxy or connector code).
