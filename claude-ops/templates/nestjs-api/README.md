# NestJS API Template

Production-ready NestJS API starter with Fastify, JWT auth, BullMQ job queue, Redis, Prisma ORM, and health checks.

## Features

- **Fastify adapter** — faster than Express, drop-in replacement
- **JWT authentication** — register/login endpoints, Passport JWT strategy
- **BullMQ job queue** — Redis-backed queue with example processor
- **Prisma ORM** — PostgreSQL with type-safe client and migrations
- **Health endpoint** — `GET /health` with database liveness check via `@nestjs/terminus`
- **Docker + docker-compose** — multi-stage build, PostgreSQL 16, Redis 7
- **Config module** — environment variables validated at startup

## Prerequisites

- Node 20+
- Docker (for local infrastructure)
- PostgreSQL 16 (or use docker-compose)
- Redis 7 (or use docker-compose)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file and fill in values
cp .env.example .env

# 3. Generate Prisma client and push schema
npx prisma generate
npx prisma db push

# 4. Start development server
npm run start:dev
```

## Environment Variables

| Variable       | Description                          | Example                                              |
| -------------- | ------------------------------------ | ---------------------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string         | `postgresql://postgres:postgres@localhost:5432/nestapp` |
| `JWT_SECRET`   | Secret for signing JWT tokens (32+ chars) | `change-me-to-a-random-secret-32-chars-min`     |
| `REDIS_HOST`   | Redis hostname                       | `localhost`                                          |
| `PORT`         | HTTP port (default 3000)             | `3000`                                               |

## API Endpoints

| Method | Path             | Auth     | Description            |
| ------ | ---------------- | -------- | ---------------------- |
| POST   | `/auth/register` | None     | Create account, get JWT |
| POST   | `/auth/login`    | None     | Login, get JWT          |
| GET    | `/health`        | None     | Database liveness check |

### Register

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"secret"}'
```

### Login

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"secret"}'
```

## Docker

Start the full stack (app + PostgreSQL + Redis):

```bash
docker-compose up --build
```

The API will be available at `http://localhost:3000`.

## Deployment

1. Set all environment variables in your hosting platform
2. Run `npx prisma migrate deploy` before each release
3. Build the Docker image: `docker build -t nestjs-api .`
4. Run with `NODE_ENV=production`

Recommended platforms: Railway, Render, AWS ECS Fargate, Fly.io.
