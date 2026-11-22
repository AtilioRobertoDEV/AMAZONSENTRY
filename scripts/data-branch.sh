#!/usr/bin/env bash
# Gerencia a branch "data", onde ficam os dados gerados (cache do mapa).
# A branch é mantida com um único commit (órfão) para o repositório não crescer
# a cada atualização. Uso:
#   scripts/data-branch.sh checkout   # baixa a branch para ./data (ou cria vazia)
#   scripts/data-branch.sh publish "mensagem"
set -euo pipefail
BRANCH="${DATA_BRANCH:-data}"
DIR="${SENTRY_DATA_DIR:-data}"

case "${1:-}" in
  checkout)
    rm -rf "$DIR"
    if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
      git fetch --depth 1 origin "$BRANCH"
      git worktree add --detach "$DIR" FETCH_HEAD
    else
      echo "branch $BRANCH ainda não existe: começando vazia"
      mkdir -p "$DIR"
    fi
    ;;
  publish)
    msg="${2:-atualiza dados}"
    tmp="$(mktemp -d)"
    cp -a "$DIR"/. "$tmp"/
    rm -rf "$tmp/.git"
    cd "$tmp"
    git init -q -b "$BRANCH"
    git config user.name "amazon-sentry-bot"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    cat > README.md <<'MD'
# Dados do AMAZON SENTRY

Branch gerada automaticamente pelos workflows em `.github/workflows/`.
Ela guarda o cache de dados que o mapa usa e é reescrita a cada atualização
(um único commit), então não faça commits manuais aqui.
MD
    git add -A
    git commit -q -m "$msg"
    git remote add origin "$(cd - >/dev/null; git config --get remote.origin.url)"
    # reaproveita as credenciais do actions/checkout
    hdr="$(cd - >/dev/null; git config --get-all http.https://github.com/.extraheader || true)"
    for i in 1 2 3 4; do
      if [ -n "$hdr" ]; then
        git -c http.https://github.com/.extraheader="$hdr" push -f origin "HEAD:refs/heads/$BRANCH" && break
      else
        git push -f origin "HEAD:refs/heads/$BRANCH" && break
      fi
      sleep $((i * 10))
    done
    ;;
  *)
    echo "uso: $0 checkout|publish [mensagem]" >&2; exit 2;;
esac
