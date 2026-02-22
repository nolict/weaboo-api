# Deployment Guide

## Prerequisites

- Bun runtime installed (v1.3.8 or later)
- Git (for version control)
- Linux/macOS/Windows with WSL

## Local Development

### 1. Installation

```bash
# Clone repository
git clone <repository-url>
cd weaboo-api

# Install dependencies
bun install
```

### 2. Development Server

```bash
# Run with hot reload
bun run dev
```

The server will start on `http://localhost:3000` with automatic restart on file changes.

### 3. Testing

```bash
# Scan target websites
bun run scan

# Test home endpoint
curl http://localhost:3000/api/v1/home
```

### 4. Code Quality

```bash
# Lint code
bun run lint

# Auto-fix linting issues
bun run lint:fix

# Format code
bun run format
```

## Production Deployment

### Using Bun Directly

```bash
# Start production server
bun start
```

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start "bun start" --name weaboo-api

# Monitor
pm2 logs weaboo-api

# Restart
pm2 restart weaboo-api

# Stop
pm2 stop weaboo-api
```

### Using Docker

Create `Dockerfile`:
```dockerfile
FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --production

COPY . .

EXPOSE 3000

CMD ["bun", "start"]
```

Build and run:
```bash
# Build image
docker build -t weaboo-api .

# Run container
docker run -p 3000:3000 weaboo-api
```

### Using Docker Compose

Create `docker-compose.yml`:
```yaml
version: '3.8'

services:
  weaboo-api:
    build: .
    ports:
      - "3000:3000"
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=3000
```

Run:
```bash
docker-compose up -d
```

## Environment Variables

Create `.env` file:
```bash
PORT=3000
NODE_ENV=production
```

Update `src/config/constants.ts` to use environment variables as needed.

## Health Monitoring

### Health Check Endpoint

```bash
# Local
curl http://localhost:3000/health

# Production
curl https://your-domain.com/health
```

### Uptime Monitoring

Use services like:
- UptimeRobot
- Pingdom
- StatusCake

Configure to ping `/health` every 5 minutes.

## Performance Tuning

### Bun Configuration

Bun runs optimally with default settings. For high traffic:

```bash
# Increase file descriptor limit
ulimit -n 65536
```

### Reverse Proxy (nginx)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## Security Checklist

- [ ] Use HTTPS in production
- [ ] Set up firewall rules
- [ ] Implement rate limiting
- [ ] Add authentication (if needed)
- [ ] Keep dependencies updated
- [ ] Monitor logs for suspicious activity
- [ ] Set up CORS properly

## Troubleshooting

### Port Already in Use

```bash
# Find process using port 3000
lsof -i :3000

# Kill process
kill -9 <PID>
```

### Provider Timeout

Check network connectivity and provider availability. The API gracefully handles provider failures.

### High Memory Usage

Monitor with:
```bash
# Using PM2
pm2 monit

# Using top
top -p $(pgrep -f "bun")
```

## Backup & Recovery

### Database
Currently no database. Future implementations should backup regularly.

### Application Logs
Configure log rotation:
```bash
# logrotate configuration
/var/log/weaboo-api/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
```

## Scaling Considerations

### Horizontal Scaling
- Deploy multiple instances behind a load balancer
- Use Redis for shared caching (future)
- Implement sticky sessions if needed

### Vertical Scaling
- Increase server resources
- Optimize provider concurrent requests
- Implement caching layer

## Support

For issues and questions, check the internal documentation or contact the development team.
