# ---- Stage 1: Builder ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY yarn.lock* .npmrc* ./

RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

COPY . .

ENV NEXT_PUBLIC_BASE_PATH=/zarr-web

# Force Webpack build (disable Turbopack)
RUN npm run build -- --webpack

# ---- Stage 2: Runner ----
FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["node", "server.js"]