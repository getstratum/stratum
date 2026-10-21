module github.com/getstratum/stratum/gateway

go 1.26

// Minimum patch release with the standard library security fixes we need.
// Older local toolchains download it automatically (GOTOOLCHAIN=auto).
toolchain go1.26.10
