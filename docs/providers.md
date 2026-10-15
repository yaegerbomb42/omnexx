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

| id              | Provider                                    | Base URL                                                                                         | Key                                           | API         |           |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- | ----------- | --------- |
| `anthropic`     | Anthropic (Claude)                          | `https://api.anthropic.com`                                                                      | `ANTHROPIC_API_KEY`                           | Anthropic   |           |
| `openai`        | OpenAI                                      | `https://api.openai.com/v1`                                                                      | `OPENAI_API_KEY`                              | OpenAI Chat |           |
| `gemini`        | Google Gemini                               | `https://generativelanguage.googleapis.com`                                                      | `GEMINI_API_KEY`, `GOOGLE_API_KEY`            | Gemini      | free tier |
| `xai`           | xAI (Grok)                                  | `https://api.x.ai/v1`                                                                            | `XAI_API_KEY`                                 | OpenAI Chat |           |
| `mistral`       | Mistral                                     | `https://api.mistral.ai/v1`                                                                      | `MISTRAL_API_KEY`                             | OpenAI Chat | free tier |
| `deepseek`      | DeepSeek                                    | `https://api.deepseek.com/v1`                                                                    | `DEEPSEEK_API_KEY`                            | OpenAI Chat |           |
| `groq`          | Groq                                        | `https://api.groq.com/openai/v1`                                                                 | `GROQ_API_KEY`                                | OpenAI Chat | free tier |
| `cerebras`      | Cerebras                                    | `https://api.cerebras.ai/v1`                                                                     | `CEREBRAS_API_KEY`                            | OpenAI Chat | free tier |
| `openrouter`    | OpenRouter (hundreds of models)             | `https://openrouter.ai/api/v1`                                                                   | `OPENROUTER_API_KEY`                          | OpenAI Chat | free tier |
| `together`      | Together AI                                 | `https://api.together.xyz/v1`                                                                    | `TOGETHER_API_KEY`                            | OpenAI Chat |           |
| `fireworks`     | Fireworks                                   | `https://api.fireworks.ai/inference/v1`                                                          | `FIREWORKS_API_KEY`                           | OpenAI Chat |           |
| `nvidia`        | NVIDIA NIM                                  | `https://integrate.api.nvidia.com/v1`                                                            | `NVIDIA_API_KEY`                              | OpenAI Chat | free tier |
| `moonshot`      | Moonshot (Kimi)                             | `https://api.moonshot.ai/v1`                                                                     | `MOONSHOT_API_KEY`                            | OpenAI Chat |           |
| `zai`           | Z.ai (GLM)                                  | `https://api.z.ai/api/paas/v4`                                                                   | `ZAI_API_KEY`                                 | OpenAI Chat |           |
| `zhipu`         | Zhipu BigModel (GLM, China)                 | `https://open.bigmodel.cn/api/paas/v4`                                                           | `ZHIPUAI_API_KEY`                             | OpenAI Chat |           |
| `dashscope`     | Alibaba Cloud (Qwen)                        | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`                                         | `DASHSCOPE_API_KEY`                           | OpenAI Chat |           |
| `minimax`       | MiniMax                                     | `https://api.minimax.io/v1`                                                                      | `MINIMAX_API_KEY`                             | OpenAI Chat |           |
| `siliconflow`   | SiliconFlow                                 | `https://api.siliconflow.com/v1`                                                                 | `SILICONFLOW_API_KEY`                         | OpenAI Chat |           |
| `deepinfra`     | DeepInfra                                   | `https://api.deepinfra.com/v1/openai`                                                            | `DEEPINFRA_API_KEY`                           | OpenAI Chat |           |
| `huggingface`   | Hugging Face Inference                      | `https://router.huggingface.co/v1`                                                               | `HF_TOKEN`                                    | OpenAI Chat | free tier |
| `perplexity`    | Perplexity                                  | `https://api.perplexity.ai`                                                                      | `PERPLEXITY_API_KEY`                          | OpenAI Chat |           |
| `cohere`        | Cohere                                      | `https://api.cohere.ai/compatibility/v1`                                                         | `COHERE_API_KEY`, `CO_API_KEY`                | OpenAI Chat | free tier |
| `vercel`        | Vercel AI Gateway                           | `https://ai-gateway.vercel.sh/v1`                                                                | `AI_GATEWAY_API_KEY`                          | OpenAI Chat |           |
| `github`        | GitHub Models                               | `https://models.github.ai/inference`                                                             | `GITHUB_TOKEN`                                | OpenAI Chat | free tier |
| `novita`        | Novita AI                                   | `https://api.novita.ai/v3/openai`                                                                | `NOVITA_API_KEY`                              | OpenAI Chat |           |
| `hyperbolic`    | Hyperbolic                                  | `https://api.hyperbolic.xyz/v1`                                                                  | `HYPERBOLIC_API_KEY`                          | OpenAI Chat |           |
| `sambanova`     | SambaNova                                   | `https://api.sambanova.ai/v1`                                                                    | `SAMBANOVA_API_KEY`                           | OpenAI Chat | free tier |
| `nebius`        | Nebius Token Factory                        | `https://api.tokenfactory.nebius.com/v1`                                                         | `NEBIUS_API_KEY`                              | OpenAI Chat |           |
| `scaleway`      | Scaleway Generative APIs                    | `https://api.scaleway.ai/v1`                                                                     | `SCW_SECRET_KEY`                              | OpenAI Chat |           |
| `requesty`      | Requesty                                    | `https://router.requesty.ai/v1`                                                                  | `REQUESTY_API_KEY`                            | OpenAI Chat |           |
| `venice`        | Venice                                      | `https://api.venice.ai/api/v1`                                                                   | `VENICE_API_KEY`                              | OpenAI Chat |           |
| `azure`         | Azure OpenAI                                | `https://{resource}.openai.azure.com/openai/v1`                                                  | `AZURE_OPENAI_API_KEY` (api-key header)       | OpenAI Chat |           |
| `azure-foundry` | Azure AI Foundry (DeepSeek, Grok, Llama, …) | `https://{resource}.services.ai.azure.com/openai/v1`                                             | `AZURE_INFERENCE_CREDENTIAL` (api-key header) | OpenAI Chat |           |
| `bedrock`       | Amazon Bedrock                              | `https://bedrock-mantle.{region}.api.aws/v1`                                                     | `AWS_BEARER_TOKEN_BEDROCK`                    | OpenAI Chat |           |
| `vertex`        | Google Vertex AI                            | `https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi` | `VERTEX_ACCESS_TOKEN`                         | OpenAI Chat |           |
| `cloudflare`    | Cloudflare Workers AI                       | `https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1`                                  | `CLOUDFLARE_API_TOKEN`                        | OpenAI Chat | free tier |
| `ollama`        | Ollama                                      | `http://localhost:11434/v1`                                                                      | none                                          | OpenAI Chat | local     |
| `lmstudio`      | LM Studio                                   | `http://localhost:1234/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `vllm`          | vLLM                                        | `http://localhost:8000/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `llamacpp`      | llama.cpp server                            | `http://localhost:8080/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `litellm`       | LiteLLM proxy                               | `http://localhost:4000/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `jan`           | Jan                                         | `http://localhost:1337/v1`                                                                       | none                                          | OpenAI Chat | local     |
| `localai`       | LocalAI                                     | `http://localhost:8080/v1`                                                                       | none                                          | OpenAI Chat | local     |

### Notes

- **Azure OpenAI / Azure AI Foundry** use the v1 API (`/openai/v1`, no `api-version`) and an
  `api-key` header. Model names are your deployment names. DeepSeek, Grok, Llama and other
  Foundry models are served on the same `/openai/v1` path.
- **Amazon Bedrock** uses its OpenAI-compatible endpoint (`bedrock-mantle`) with a Bedrock API key
  (`AWS_BEARER_TOKEN_BEDROCK`). AWS SigV4 signing (access key + secret) is not supported; create
  a Bedrock API key in the console, or point a LiteLLM proxy at Bedrock.
- **Google Vertex AI** uses its OpenAI-compatible endpoint; the key is an OAuth access token
  (`gcloud auth print-access-token`), which expires after an hour.
- **Lambda** retired its inference API in 2025 and is not listed.
- Anthropic-compatible gateways (for example MiniMax's or Moonshot's `/anthropic` endpoints) work
  as custom endpoints with the Anthropic flavor detected or picked.
