# Providers

omnexx talks to any model API that speaks one of four wire formats: OpenAI Chat Completions,
the OpenAI Responses API, the Anthropic Messages API, or Google Gemini. The providers below are
known by name (the list lives in [`src/providers/catalog.ts`](../src/providers/catalog.ts));
anything else is a **custom endpoint**: a base URL and a key.

## Adding one

- **VS Code**: Settings (the gear) → _Add a provider_. Search the gallery, pick a tile, fill the
  form it shows (a key; for Azure, Bedrock, Vertex and Cloudflare also a resource name, region,
  project or account id), press **Test** to check it without saving, then **Connect**.
- **Terminal UI**: `/provider` lists everything; `/provider azure KEY resource=my-res`,
  `/provider https://host/v1 KEY [--header Name:value] [--flavor anthropic]`, and
  `/provider test <id|url> KEY` (checks without saving). `/connect <name> KEY` and pasting a key
  still work for the plain providers.
- **CLI**: `omnexx providers catalog`, then
  `omnexx providers add azure --key KEY --field resource=my-res`, or for any endpoint
  `omnexx providers add mybox --base-url https://host --key KEY [--header "X-Org: team"] [--flavor anthropic]`.
  Run `omnexx providers add` with no flags at a terminal to be asked for each value.

Keys go to a private credentials file (0600) and are only ever shown masked; config files only
hold the base URL, API kind, auth style and any extra headers.

## Custom endpoints: what the probe does

Given only a base URL and a key, omnexx works out the rest:

1. `GET {url}/models` with a bearer key: an OpenAI-compatible list means **OpenAI Chat**. If the
   URL has no version segment it also tries `{url}/v1/models`, and saves the corrected URL.
2. `GET {url}/v1/models` with `x-api-key` and `anthropic-version`: an Anthropic-shaped list
   means **Anthropic Messages** (URLs containing "anthropic" are tried this way first).
3. Servers without a model list: a deliberately invalid 1-token request (model
   `omnexx-probe`) to `/chat/completions` or `/v1/messages`; an error in that API's own shape
   proves the endpoint. Nothing is generated or billed.

Failures are reported in words you can act on:

| Answer    | Message                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| 401       | `401: key rejected — check the API key (and that it is for this provider)`             |
| 403       | `403: the key works but isn't allowed here — check its permissions or plan`            |
| 404       | `404: nothing at <url> — the base URL probably needs /v1 (or the provider's API path)` |
| 429       | `429: rate limited or out of credit — the key is accepted`                             |
| no answer | `couldn't reach <host> — is the URL right and the server running?`                     |

A remote endpoint that fails the probe is not saved; a local one (localhost) is, since the server
may simply not be running yet.

## Known providers

| id                    | Provider                                    | Base URL                                                                                         | Key                                           | API         |           |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- | ----------- | --------- |
| `anthropic`           | Anthropic (Claude)                          | `https://api.anthropic.com`                                                                      | `ANTHROPIC_API_KEY`                           | Anthropic   |           |
| `openai`              | OpenAI                                      | `https://api.openai.com/v1`                                                                      | `OPENAI_API_KEY`                              | OpenAI Chat |           |
| `gemini`              | Google Gemini                               | `https://generativelanguage.googleapis.com`                                                      | `GEMINI_API_KEY`, `GOOGLE_API_KEY`            | Gemini      | free tier |
| `xai`                 | xAI (Grok)                                  | `https://api.x.ai/v1`                                                                            | `XAI_API_KEY`                                 | OpenAI Chat |           |
| `mistral`             | Mistral                                     | `https://api.mistral.ai/v1`                                                                      | `MISTRAL_API_KEY`                             | OpenAI Chat | free tier |
| `deepseek`            | DeepSeek                                    | `https://api.deepseek.com/v1`                                                                    | `DEEPSEEK_API_KEY`                            | OpenAI Chat |           |
| `groq`                | Groq                                        | `https://api.groq.com/openai/v1`                                                                 | `GROQ_API_KEY`                                | OpenAI Chat | free tier |
| `cerebras`            | Cerebras                                    | `https://api.cerebras.ai/v1`                                                                     | `CEREBRAS_API_KEY`                            | OpenAI Chat | free tier |
| `openrouter`          | OpenRouter (hundreds of models)             | `https://openrouter.ai/api/v1`                                                                   | `OPENROUTER_API_KEY`                          | OpenAI Chat | free tier |
| `together`            | Together AI                                 | `https://api.together.xyz/v1`                                                                    | `TOGETHER_API_KEY`                            | OpenAI Chat |           |
| `fireworks`           | Fireworks                                   | `https://api.fireworks.ai/inference/v1`                                                          | `FIREWORKS_API_KEY`                           | OpenAI Chat |           |
| `nvidia`              | NVIDIA NIM                                  | `https://integrate.api.nvidia.com/v1`                                                            | `NVIDIA_API_KEY`                              | OpenAI Chat | free tier |
| `moonshot`            | Moonshot (Kimi)                             | `https://api.moonshot.ai/v1`                                                                     | `MOONSHOT_API_KEY`                            | OpenAI Chat |           |
| `zai`                 | Z.ai (GLM)                                  | `https://api.z.ai/api/paas/v4`                                                                   | `ZAI_API_KEY`                                 | OpenAI Chat |           |
| `zhipu`               | Zhipu BigModel (GLM, China)                 | `https://open.bigmodel.cn/api/paas/v4`                                                           | `ZHIPUAI_API_KEY`                             | OpenAI Chat |           |
| `dashscope`           | Alibaba Cloud (Qwen)                        | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`                                         | `DASHSCOPE_API_KEY`                           | OpenAI Chat |           |
| `minimax`             | MiniMax                                     | `https://api.minimax.io/v1`                                                                      | `MINIMAX_API_KEY`                             | OpenAI Chat |           |
| `siliconflow`         | SiliconFlow                                 | `https://api.siliconflow.com/v1`                                                                 | `SILICONFLOW_API_KEY`                         | OpenAI Chat |           |
| `deepinfra`           | DeepInfra                                   | `https://api.deepinfra.com/v1/openai`                                                            | `DEEPINFRA_API_KEY`                           | OpenAI Chat |           |
| `huggingface`         | Hugging Face Inference                      | `https://router.huggingface.co/v1`                                                               | `HF_TOKEN`                                    | OpenAI Chat | free tier |
| `perplexity`          | Perplexity                                  | `https://api.perplexity.ai`                                                                      | `PERPLEXITY_API_KEY`                          | OpenAI Chat |           |
| `cohere`              | Cohere                                      | `https://api.cohere.ai/compatibility/v1`                                                         | `COHERE_API_KEY`, `CO_API_KEY`                | OpenAI Chat | free tier |
| `vercel`              | Vercel AI Gateway                           | `https://ai-gateway.vercel.sh/v1`                                                                | `AI_GATEWAY_API_KEY`                          | OpenAI Chat |           |
| `github`              | GitHub Models                               | `https://models.github.ai/inference`                                                             | `GITHUB_TOKEN`                                | OpenAI Chat | free tier |
| `novita`              | Novita AI                                   | `https://api.novita.ai/v3/openai`                                                                | `NOVITA_API_KEY`                              | OpenAI Chat |           |
| `hyperbolic`          | Hyperbolic                                  | `https://api.hyperbolic.xyz/v1`                                                                  | `HYPERBOLIC_API_KEY`                          | OpenAI Chat |           |
| `sambanova`           | SambaNova                                   | `https://api.sambanova.ai/v1`                                                                    | `SAMBANOVA_API_KEY`                           | OpenAI Chat | free tier |
| `nebius`              | Nebius Token Factory                        | `https://api.tokenfactory.nebius.com/v1`                                                         | `NEBIUS_API_KEY`                              | OpenAI Chat |           |
| `scaleway`            | Scaleway Generative APIs                    | `https://api.scaleway.ai/v1`                                                                     | `SCW_SECRET_KEY`                              | OpenAI Chat |           |
| `requesty`            | Requesty                                    | `https://router.requesty.ai/v1`                                                                  | `REQUESTY_API_KEY`                            | OpenAI Chat |           |
| `venice`              | Venice                                      | `https://api.venice.ai/api/v1`                                                                   | `VENICE_API_KEY`                              | OpenAI Chat |           |
| `azure`               | Azure OpenAI                                | `https://{resource}.openai.azure.com/openai/v1`                                                  | `AZURE_OPENAI_API_KEY` (api-key header)       | OpenAI Chat |           |
| `azure-foundry`       | Azure AI Foundry (DeepSeek, Grok, Llama, …) | `https://{resource}.services.ai.azure.com/openai/v1`                                             | `AZURE_INFERENCE_CREDENTIAL` (api-key header) | OpenAI Chat |           |
| `bedrock`             | Amazon Bedrock                              | `https://bedrock-mantle.{region}.api.aws/v1`                                                     | `AWS_BEARER_TOKEN_BEDROCK`                    | OpenAI Chat |           |
| `vertex`              | Google Vertex AI                            | `https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi` | `VERTEX_ACCESS_TOKEN`                         | OpenAI Chat |           |
| `cloudflare`          | Cloudflare Workers AI                       | `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1`                                  | `CLOUDFLARE_API_TOKEN`                        | OpenAI Chat | free tier |
| `ai21`                | AI21 (Jamba)                                | `https://api.ai21.com/studio/v1`                                                                 | `AI21_API_KEY`                                | OpenAI Chat |           |
| `baseten`             | Baseten Model APIs                          | `https://inference.baseten.co/v1`                                                                | `BASETEN_API_KEY`                             | OpenAI Chat |           |
| `featherless`         | Featherless                                 | `https://api.featherless.ai/v1`                                                                  | `FEATHERLESS_API_KEY`                         | OpenAI Chat |           |
| `chutes`              | Chutes                                      | `https://llm.chutes.ai/v1`                                                                       | `CHUTES_API_KEY`                              | OpenAI Chat |           |
| `inference-net`       | Inference.net                               | `https://api.inference.net/v1`                                                                   | `INFERENCE_API_KEY`                           | OpenAI Chat |           |
| `friendli`            | Friendli Serverless                         | `https://api.friendli.ai/serverless/v1`                                                          | `FRIENDLI_TOKEN`                              | OpenAI Chat |           |
| `parasail`            | Parasail                                    | `https://api.parasail.io/v1`                                                                     | `PARASAIL_API_KEY`                            | OpenAI Chat |           |
| `nscale`              | nscale                                      | `https://inference.api.nscale.com/v1`                                                            | `NSCALE_API_KEY`                              | OpenAI Chat |           |
| `crusoe`              | Crusoe Managed Inference                    | `https://api.inference.crusoecloud.com/v1`                                                       | `CRUSOE_API_KEY`                              | OpenAI Chat |           |
| `ionos`               | IONOS AI Model Hub                          | `https://openai.inference.de-txl.ionos.com/v1`                                                   | `IONOS_API_TOKEN`                             | OpenAI Chat |           |
| `upstage`             | Upstage (Solar)                             | `https://api.upstage.ai/v1`                                                                      | `UPSTAGE_API_KEY`                             | OpenAI Chat |           |
| `reka`                | Reka                                        | `https://api.reka.ai/v1`                                                                         | `REKA_API_KEY`                                | OpenAI Chat |           |
| `stepfun`             | StepFun                                     | `https://api.stepfun.ai/v1`                                                                      | `STEP_API_KEY`, `STEPFUN_API_KEY`             | OpenAI Chat |           |
| `stepfun-cn`          | StepFun (China)                             | `https://api.stepfun.com/v1`                                                                     | `STEP_API_KEY`, `STEPFUN_API_KEY`             | OpenAI Chat |           |
| `volcengine`          | Volcengine Ark (Doubao, China)              | `https://ark.cn-beijing.volces.com/api/v3`                                                       | `ARK_API_KEY`                                 | OpenAI Chat |           |
| `byteplus`            | BytePlus ModelArk (Seed)                    | `https://ark.ap-southeast.bytepluses.com/api/v3`                                                 | `ARK_API_KEY`                                 | OpenAI Chat |           |
| `qianfan`             | Baidu Qianfan (ERNIE)                       | `https://qianfan.baidubce.com/v2`                                                                | `QIANFAN_API_KEY`                             | OpenAI Chat |           |
| `spark`               | iFlytek Spark                               | `https://spark-api-open.xf-yun.com/v1`                                                           | `SPARK_API_PASSWORD`                          | OpenAI Chat | free tier |
| `sensenova`           | SenseNova                                   | `https://token.sensenova.cn/v1`                                                                  | `SENSENOVA_API_KEY`                           | OpenAI Chat | free tier |
| `ollama-cloud`        | Ollama Cloud                                | `https://ollama.com/v1`                                                                          | `OLLAMA_API_KEY`                              | OpenAI Chat |           |
| `snowflake`           | Snowflake Cortex                            | `https://{account}.snowflakecomputing.com/api/v2/cortex/v1`                                      | `SNOWFLAKE_PAT`                               | OpenAI Chat |           |
| `databricks`          | Databricks Model Serving                    | `https://{workspace}/serving-endpoints`                                                          | `DATABRICKS_TOKEN`                            | OpenAI Chat |           |
| `helicone`            | Helicone AI Gateway                         | `https://ai-gateway.helicone.ai/v1`                                                              | `HELICONE_API_KEY`                            | OpenAI Chat |           |
| `martian`             | Martian                                     | `https://api.withmartian.com/v1`                                                                 | `MARTIAN_API_KEY`                             | OpenAI Chat |           |
| `ollama`              | Ollama                                      | `http://localhost:11434/v1`                                                                      | none                                          | OpenAI Chat | local     |
| `lmstudio`            | LM Studio                                   | `http://localhost:1234/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `vllm`                | vLLM                                        | `http://localhost:8000/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `llamacpp`            | llama.cpp server                            | `http://localhost:8080/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `litellm`             | LiteLLM proxy                               | `http://localhost:4000/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `jan`                 | Jan                                         | `http://localhost:1337/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `localai`             | LocalAI                                     | `http://localhost:8080/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `koboldcpp`           | KoboldCpp                                   | `http://localhost:5001/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `textgen`             | text-generation-webui                       | `http://localhost:5000/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `llamafile`           | Llamafile                                   | `http://localhost:8080/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `mlx-lm`              | MLX-LM server                               | `http://localhost:8080/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `aphrodite`           | Aphrodite Engine                            | `http://localhost:2242/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `sglang`              | SGLang                                      | `http://localhost:30000/v1`                                                                      | none                                          | OpenAI Chat | local     |
| `xinference`          | Xinference                                  | `http://localhost:9997/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `docker-model-runner` | Docker Model Runner                         | `http://localhost:12434/engines/v1`                                                              | none                                          | OpenAI Chat | local     |
| `lemonade`            | Lemonade Server                             | `http://localhost:13305/api/v1`                                                                  | none                                          | OpenAI Chat | local     |
| `gpt4all`             | GPT4All                                     | `http://localhost:4891/v1`                                                                       | none                                          | OpenAI Chat | local     |

### Notes

- **Azure OpenAI / Azure AI Foundry** use the v1 API (`/openai/v1`, no `api-version`) and an
  `api-key` header. Model names are your deployment names. DeepSeek, Grok, Llama and other
  Foundry models are served on the same `/openai/v1` path.
- **Amazon Bedrock** uses its OpenAI-compatible endpoint (`bedrock-mantle`) with a Bedrock API key
  (`AWS_BEARER_TOKEN_BEDROCK`). AWS SigV4 signing (access key + secret) is not supported; create
  a Bedrock API key in the console, or point a LiteLLM proxy at Bedrock.
- **Google Vertex AI** uses its OpenAI-compatible endpoint; the key is an OAuth access token
  (`gcloud auth print-access-token`), which expires after an hour.
- **Snowflake Cortex** and **Databricks** take your account identifier / workspace host in the
  URL; Databricks model names are serving endpoint names.
- **Ollama Cloud** (`ollama-cloud`) is Ollama's hosted service; `ollama` is the local server.
- **Not listed** (checked 2026-10): Kluster.ai, Lepton, Targon and Inflection no longer run a
  public inference API; 01.AI (Yi) closed its model service; Tencent Hunyuan's endpoint takes no
  new customers; Writer uses `/v1/chat` rather than `/chat/completions`; Portkey needs its own
  `x-portkey-api-key` header; Oracle OCI needs a project header; watsonx's gateway is a preview;
  Cloudflare AI Gateway's compat endpoint is deprecated (use `cloudflare`); Kong is self-hosted
  only; NotDiamond only recommends models; Unify's router is gone; TabbyAPI and AnythingLLM need a
  key and Msty's port isn't documented. OVHcloud and Baichuan could not be confirmed from their
  docs. Any of these that speak a supported API still work as custom endpoints.
- **Lambda** retired its inference API in 2025 and is not listed.
- Anthropic-compatible gateways (for example MiniMax's or Moonshot's `/anthropic` endpoints) work
  as custom endpoints with the Anthropic flavor detected or picked.
