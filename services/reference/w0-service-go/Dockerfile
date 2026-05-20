FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod ./
COPY main.go main_test.go ./
RUN go test ./...
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/w0-service

FROM gcr.io/distroless/base-debian12
COPY --from=build /out/w0-service /usr/local/bin/w0-service
ENTRYPOINT ["/usr/local/bin/w0-service"]
