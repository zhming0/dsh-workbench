variable "IMAGE" {
  default = "ghcr.io/zhming0/dsh-runner"
}

variable "VERSION" {
  default = "dev"
}

group "default" {
  targets = ["production"]
}

# Native single-platform build for local work and the CI smoke test.
target "dev" {
  context    = "runner"
  dockerfile = "Dockerfile"
  tags       = ["dsh-runner:dev"]
}

target "production" {
  context    = "runner"
  dockerfile = "Dockerfile"
  tags = [
    "${IMAGE}:${VERSION}",
    "${IMAGE}:latest"
  ]
  platforms = ["linux/amd64", "linux/arm64"]
}
