variable "IMAGE" {
  default = "ghcr.io/zhming0/dsh-runner"
}

variable "HOST_IMAGE" {
  default = "ghcr.io/zhming0/dsh-host"
}

variable "VERSION" {
  default = "dev"
}

group "default" {
  targets = ["production"]
}

# Everything a release pushes. The two images share one version by
# construction: the host image build stamps VERSION into the provider and
# asserts its default runner tag matches.
group "release" {
  targets = ["production", "host-production"]
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

# Native single-platform host image for local work and the CI composition
# check. The default VERSION is not a valid semver for `npm version`, so the
# dev build uses its own placeholder.
target "host-dev" {
  context    = "."
  dockerfile = "host/Dockerfile"
  args       = { VERSION = "0.0.0-dev" }
  tags       = ["dsh-host:dev"]
}

target "host-production" {
  context    = "."
  dockerfile = "host/Dockerfile"
  args       = { VERSION = "${VERSION}" }
  tags = [
    "${HOST_IMAGE}:${VERSION}",
    "${HOST_IMAGE}:latest"
  ]
  platforms = ["linux/amd64", "linux/arm64"]
}
