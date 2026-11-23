# AMAZON SENTRY

Mapa interativo do Brasil com três ameaças ambientais: **queimadas**, **desmatamento** e **garimpo**.
Dá para ver **ao vivo** (últimas 24 h), **semana**, **mês**, **ano** e a **série histórica** ano a ano,
com botão de reprodução, no estilo do Google Earth Timelapse.

Tudo roda em GitHub Actions e GitHub Pages. Os dados são baixados de fontes internacionais e
**copiados para o próprio repositório** (branch `data`), então o mapa nunca depende de uma fonte
externa estar no ar na hora da visita. Não usamos serviços do governo brasileiro.

## Fontes

| Camada | Fonte | Período | Atualização |
|---|---|---|---|
| Queimadas | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) (VIIRS NOAA-20/21, S-NPP, MODIS) | 2000 → hoje | a cada 3 h |
| Desmatamento (alertas) | [GLAD-L, Univ. de Maryland](https://glad.umd.edu/) (Landsat 30 m) | 2021 → hoje | diária |
| Desmatamento (anual) | [Hansen/UMD Global Forest Change](https://glad.earthengine.app/view/global-forest-change) (cobertura ≥ 30%) | 2001 → último ano publicado | anual |
| Garimpo | [Amazon Mining Watch](https://amazonminingwatch.org) (Earth Genome, Pulitzer Center, Amazon Conservation), CC BY 4.0 | 2018 → hoje (Amazônia) | semanal |
| Pistas de pouso sem registro | Candidatas do [OpenStreetMap](https://www.openstreetmap.org) (ODbL), [OurAirports](https://ourairports.com/data/) e MapBiomas; conferidas nas imagens [Sentinel-2 L2A](https://registry.opendata.aws/sentinel-2-l2a-cogs/) (Copernicus, AWS) | 2017 → hoje (antes, pela perda Hansen) | diária, em lotes |
| Imagem de fundo | Esri World Imagery; Sentinel-2 cloudless © EOX (mosaicos anuais) | 2016 → 2024 | — |

Os dados de desmatamento vêm direto do bucket público da UMD no Google Cloud Storage
(`earthenginepartners-hansen`), sem chave. Os focos vêm dos arquivos públicos de 7 dias da FIRMS.

**Limitação importante:** satélite mostra perda de floresta e áreas de garimpo, não a legalidade.
Para chamar de "ilegal" é preciso cruzar com autorizações, terras indígenas e unidades de conservação
(próxima etapa).

## Como funciona

```
pipeline/            scripts Python que baixam e agregam os dados
  fires.py           NASA FIRMS -> fires/live.json, fires/recent.json, fires/<ano>.json
  deforestation.py   GLAD-L + Hansen -> deforestation/alerts/*.json, deforestation/loss/*.json
  mining.py          Amazon Mining Watch -> mining/detections.json
  airstrips.py       pistas sem registro: candidatas + checagem no Sentinel-2 -> airstrips/airstrips.json
  sentinel2.py       leitura de janelas Sentinel-2 L2A (COGs públicos) e o detector de pistas
site/                mapa estático (MapLibre GL, sem build)
.github/workflows/   automação
scripts/data-branch.sh   guarda os dados na branch `data` (um único commit, sem crescer o repo)
```

Workflows:

- `data-fires.yml`: a cada 3 horas. Na primeira execução também preenche o histórico desde 2000.
- `data-deforestation.yml`: diário. Na primeira execução processa os alertas desde 2021 e a perda anual
  Hansen (leva perto de 1 hora). Depois só reprocessa a perda anual quando sai versão nova.
- `data-mining.yml`: semanal.
- `data-airstrips.yml`: diário. Junta as candidatas e confere no Sentinel-2 um lote por rodada (até ~4 h);
  as já conferidas ficam em cache e são revistas a cada 45 dias.
- `deploy.yml`: monta o site com os dados e publica no GitHub Pages. Roda após cada atualização.
- `ci.yml`: teste rápido do pipeline em cada pull request.

Os dados agregados usam uma grade regular (0,02° a 0,25°, conforme o período) para o navegador
carregar rápido. O formato está descrito em `pipeline/common.py`.

## Configuração (uma vez)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   (Em repositório privado, o GitHub Pages exige plano pago; em repositório público é grátis.)
2. Opcional: **Settings → Secrets and variables → Actions → `FIRMS_MAP_KEY`** com uma chave gratuita
   da FIRMS (<https://firms.modaps.eosdis.nasa.gov/api/map_key/>). Sem ela o mapa funciona, mas o
   começo do ano corrente só é preenchido se o arquivo anual por país da FIRMS estiver disponível.
3. Rode os workflows de dados uma vez em **Actions → (workflow) → Run workflow**, ou espere o agendamento.

## Rodar localmente

```bash
pip install -r pipeline/requirements.txt
cd pipeline
SENTRY_DATA_DIR=../site/data python fires.py live
SENTRY_DATA_DIR=../site/data python deforestation.py alerts
SENTRY_DATA_DIR=../site/data python mining.py
cd ../site && python -m http.server 8000   # abra http://localhost:8000
```

Links diretos: `?modo=history&ano=2019`, `?modo=week`, `?modo=year`.

## Próximas etapas

- Imagens Landsat desde 1985 (timelapse completo) via Google Earth Engine, quando houver uma conta de serviço.
- Cruzar com terras indígenas e unidades de conservação para destacar o que é provavelmente ilegal.
- Alertas integrados (GLAD-S2 e RADD) para detecção mais rápida em áreas nubladas.

## Pistas de pouso sem registro

Cada candidata (OSM, OurAirports, MapBiomas) que não tem código de aeródromo é conferida no Sentinel-2:
um filtro de linha orientado procura, a até ~500 m do ponto, uma faixa reta e estreita de solo exposto com
vegetação dos dois lados, e mede o eixo (comprimento e direção). Com o eixo fixo, mede-se ano a ano quanto
da pista está limpa, na cena menos nublada de cada ano. Anos com imagem ruim (nuvem e sombra na máscara SCL,
ou névoa que deixa a vegetação bem mais apagada que nos outros anos) são ignorados. Daí saem a janela em
que a pista surgiu, a situação no último ano (em uso, perdendo uso, abandonada, reaberta) e a distância até
o garimpo mais próximo. "Sem registro" quer dizer que não achamos registro, não que a pista seja ilegal.

Ficam de fora as pistas de cidade, vila ou aldeia (pelo nome, município ou código IATA): muitas não estão
na lista da ANAC, mas são de uso público. O detector também varre a imagem em volta dos garimpos atrás de
pistas que ninguém mapeou. Por enquanto o que só ele acha não vai para o mapa: na conferência por amostra,
a maior parte era estrada, rio ou canal de garimpo (`SHOW_DETECTOR` em `airstrips.py`).
