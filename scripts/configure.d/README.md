# configure.d

`scripts/configure.sh` runs every `*.sh` file here in name order (`10-...`, `50-...`) after its own
settings. Each file belongs to one feature, is sourced with the same helpers (`occ`, `dc`, `log`,
`secret_path`, `have_secret`) and must be safe to run again.
