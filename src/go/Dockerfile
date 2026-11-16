# syntax=docker/dockerfile:1
#
# Mailagenten - AI-tjänsten som läser och sorterar mail.
#
#   docker build -t mailagent:latest src/go
#
# Klienten lyssnar på HTTP-API:t (/api/v1) och MCP-endpointen (/mcp).
# I klustret körs den som deploymenten `mailagent`, se
# environments/base/mailagent-deployment.yaml.

# =============================================================================
# Build
# =============================================================================
FROM golang:1.23-alpine AS builder

WORKDIR /build

ENV GOTOOLCHAIN=auto

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o mailagent .

# =============================================================================
# Runtime
# =============================================================================
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /build/mailagent /app/mailagent
COPY --from=builder /build/config/config.yaml /app/config/config.yaml
COPY --from=builder /build/rules.md /app/rules.md

# OAuth-token cachas här. Monteras som emptyDir i klustret så att
# inloggningen inte måste göras om efter varje pod-omstart.
ENV XDG_CACHE_HOME=/cache
ENV HOME=/root

EXPOSE 8401 8402

CMD ["/app/mailagent"]
