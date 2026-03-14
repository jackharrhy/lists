FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

FROM oven/bun:1
WORKDIR /app
COPY --from=build /app /app
ENV DB_PATH=/data/lists.db
VOLUME /data
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
