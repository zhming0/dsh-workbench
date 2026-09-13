variable "IMAGE" {
  default = "ghcr.io/zhming0/dsh-yawn-runner"
}

variable "CONTROL_PLANE_IMAGE" {
  default = "ghcr.io/zhming0/dsh-yawn-control-plane"
}

variable "VERSION" {
  default = "dev"
}

group "default" {
  targets = ["production"]
}

# Everything a release pushes. The two images share one version by
# construction: the control-plane image build stamps VERSION into the package and
# asserts its default runner tag matches.
#
# Both targets publish a multi-arch index. GHCR reads package metadata for a
# multi-arch image from the annotations on that index, while a Dockerfile label
# only reaches the per-platform images, so each target names its source
# repository as an index annotation too.
group "release" {
  targets = ["production", "control-plane-production"]
}

# Native single-platform build for local work and the CI smoke test.
target "dev" {
  context    = "runner"
  dockerfile = "Dockerfile"
  tags       = ["dsh-yawn-runner:dev"]
}

target "production" {
  context    = "runner"
  dockerfile = "Dockerfile"
  tags = [
    "${IMAGE}:${VERSION}",
    "${IMAGE}:latest"
  ]
  platforms = ["linux/amd64", "linux/arm64"]
  annotations = [
    "index:org.opencontainers.image.source=https://github.com/zhming0/dsh-yawn"
  ]
}

# Native single-platform control-plane image for local work and the CI composition
# check. The default VERSION is not a valid semver for `npm version`, so the
# dev build uses its own placeholder.
target "control-plane-dev" {
  context    = "."
  dockerfile = "control-plane/Dockerfile"
  args       = { VERSION = "0.0.0-dev" }
  tags       = ["dsh-yawn-control-plane:dev"]
}

target "control-plane-production" {
  context    = "."
  dockerfile = "control-plane/Dockerfile"
  args       = { VERSION = "${VERSION}" }
  tags = [
    "${CONTROL_PLANE_IMAGE}:${VERSION}",
    "${CONTROL_PLANE_IMAGE}:latest"
  ]
  platforms = ["linux/amd64", "linux/arm64"]
  annotations = [
    "index:org.opencontainers.image.source=https://github.com/zhming0/dsh-yawn"
  ]
}
