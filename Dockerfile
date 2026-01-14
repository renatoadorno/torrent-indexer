# Stage 1: Build the application
FROM oven/bun:1 AS builder

WORKDIR /usr/src/app

# Copy package files
# Note: We use bun.lock instead of bun.lockb as confirmed by file listing
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the application as a standalone binary
# --compile: compiles to a single binary
# --minify: minifies the code
# --sourcemap: generates sourcemaps for debugging
RUN bun build --compile --minify --sourcemap ./index.ts --outfile server

# Stage 2: Create the production image
FROM debian:stable-slim

WORKDIR /usr/src/app

# Set production environment
ENV NODE_ENV=production

# Install ca-certificates for HTTPS requests
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN useradd -m -u 1000 appuser

# Copy the compiled binary from the builder stage
COPY --from=builder --chown=appuser:appuser /usr/src/app/server .

# Switch to non-root user
USER appuser

# Expose the port the app runs on
EXPOSE 3000

# Run the binary
CMD ["./server"]
