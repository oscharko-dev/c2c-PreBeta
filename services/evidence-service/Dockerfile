FROM golang:1.22-alpine AS build
WORKDIR /app

COPY go.mod ./
COPY *.go ./

RUN go test ./...
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/evidence-service .

FROM gcr.io/distroless/base-debian12
COPY --from=build /out/evidence-service /usr/local/bin/evidence-service
ENTRYPOINT ["/usr/local/bin/evidence-service"]
