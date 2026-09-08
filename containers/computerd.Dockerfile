# The workspace container is the pinned Cloudflare Computer image. Cloudflare containers cannot
# pull ghcr.io until the deploying account configures that registry, so wrangler builds this file
# and pushes the result to the account's own managed registry.
FROM ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f
LABEL org.opencontainers.image.title="cf-stumble workspace host"
