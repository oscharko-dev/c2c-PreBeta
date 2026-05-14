# Build stage — golang alpine on Go 1.22. Refresh tag when bumping toolchain.
# Pin to a digest in a follow-up pass once a Renovate/Dependabot policy is
# in place across the W0 service Dockerfiles.
FROM golang:1.22-alpine AS build
WORKDIR /app

COPY go.mod ./
COPY *.go ./

RUN go test ./...
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/evidence-service .

# Runtime stage — distroless static-debian12:nonroot. The `nonroot` variant
# bakes in uid:gid 65532:65532 so the binary never runs as root.
FROM gcr.io/distroless/static-debian12:nonroot
USER 65532:65532
COPY --from=build /out/evidence-service /usr/local/bin/evidence-service
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/evidence-service"]
