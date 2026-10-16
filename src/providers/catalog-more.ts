/**
 * Catalog entries added in the second pass (checked 2026-10 against each provider's docs):
 * inference hosts, regional labs, data platforms, gateways and more local servers. Where a
 * provider's docs name no key variable, the conventional `<PROVIDER>_API_KEY` is used.
 */

import { type CatalogEntry, hosted, local } from './catalog-types.js';

/** Inference hosts and labs that speak OpenAI Chat at a fixed URL. */
const HOSTS: readonly CatalogEntry[] = [
  hosted(
    'ai21',
    'AI21 (Jamba)',
    'https://api.ai21.com/studio/v1',
    'AI21_API_KEY',
    'https://studio.ai21.com',
    { modelsPath: null, docs: 'https://docs.ai21.com/reference/jamba-1-6-api-ref' },
  ),
  hosted(
    'baseten',
    'Baseten Model APIs',
    'https://inference.baseten.co/v1',
    'BASETEN_API_KEY',
    'https://app.baseten.co/settings/api_keys',
    { docs: 'https://docs.baseten.co/development/model-apis/overview' },
  ),
  hosted(
    'featherless',
    'Featherless',
    'https://api.featherless.ai/v1',
    'FEATHERLESS_API_KEY',
    'https://featherless.ai/account/api-keys',
    { docs: 'https://featherless.ai/docs/quickstart-guide' },
  ),
  hosted('chutes', 'Chutes', 'https://llm.chutes.ai/v1', 'CHUTES_API_KEY', 'https://chutes.ai', {
    keyPrefix: 'cpk_',
    docs: 'https://chutes.ai/docs',
  }),
  hosted(
    'inference-net',
    'Inference.net',
    'https://api.inference.net/v1',
    'INFERENCE_API_KEY',
    'https://inference.net/register',
    { docs: 'https://docs.inference.net/api/api-quickstart' },
  ),
  hosted(
    'friendli',
    'Friendli Serverless',
    'https://api.friendli.ai/serverless/v1',
    'FRIENDLI_TOKEN',
    'https://friendli.ai/suite/~/setting/keys',
    {
      modelsPath: null,
      docs: 'https://friendli.ai/docs/guides/serverless_endpoints/quickstart',
    },
  ),
  hosted(
    'parasail',
    'Parasail',
    'https://api.parasail.io/v1',
    'PARASAIL_API_KEY',
    'https://www.saas.parasail.io/keys',
    { docs: 'https://docs.parasail.io/parasail-docs/quickstart/serverless' },
  ),
  hosted(
    'nscale',
    'nscale',
    'https://inference.api.nscale.com/v1',
    'NSCALE_API_KEY',
    'https://console.nscale.com',
    { note: 'the key is a service token (Settings → Service Tokens)' },
  ),
  hosted(
    'crusoe',
    'Crusoe Managed Inference',
    'https://api.inference.crusoecloud.com/v1',
    'CRUSOE_API_KEY',
    'https://console.crusoecloud.com',
    {
      modelsPath: null,
      docs: 'https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference',
    },
  ),
  hosted(
    'ionos',
    'IONOS AI Model Hub',
    'https://openai.inference.de-txl.ionos.com/v1',
    'IONOS_API_TOKEN',
    'https://dcd.ionos.com',
    {
      note: 'the key is a token from the DCD Token Manager',
      docs: 'https://docs.ionos.com/cloud/ai/ai-model-hub',
    },
  ),
  hosted(
    'upstage',
    'Upstage (Solar)',
    'https://api.upstage.ai/v1',
    'UPSTAGE_API_KEY',
    'https://console.upstage.ai/api-keys',
    { modelsPath: null, docs: 'https://console.upstage.ai/docs/getting-started' },
  ),
  hosted('reka', 'Reka', 'https://api.reka.ai/v1', 'REKA_API_KEY', 'https://developer.reka.ai', {
    modelsPath: null,
    docs: 'https://docs.reka.ai/quickstart',
  }),
  hosted(
    'stepfun',
    'StepFun',
    'https://api.stepfun.ai/v1',
    'STEP_API_KEY',
    'https://platform.stepfun.ai/interface-key',
    { keyEnvs: ['STEP_API_KEY', 'STEPFUN_API_KEY'] },
  ),
  hosted(
    'stepfun-cn',
    'StepFun (China)',
    'https://api.stepfun.com/v1',
    'STEP_API_KEY',
    'https://platform.stepfun.com/interface-key',
    { keyEnvs: ['STEP_API_KEY', 'STEPFUN_API_KEY'] },
  ),
  hosted(
    'volcengine',
    'Volcengine Ark (Doubao, China)',
    'https://ark.cn-beijing.volces.com/api/v3',
    'ARK_API_KEY',
    'https://console.volcengine.com/ark',
    { modelsPath: null, docs: 'https://docs.volcengine.com/docs/82379/1330626' },
  ),
  hosted(
    'byteplus',
    'BytePlus ModelArk (Seed)',
    'https://ark.ap-southeast.bytepluses.com/api/v3',
    'ARK_API_KEY',
    'https://console.byteplus.com/ark/region:ap-southeast-1/',
    { modelsPath: null, docs: 'https://docs.byteplus.com/en/docs/ModelArk/1298459' },
  ),
  hosted(
    'qianfan',
    'Baidu Qianfan (ERNIE)',
    'https://qianfan.baidubce.com/v2',
    'QIANFAN_API_KEY',
    'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    { keyPrefix: 'bce-v3/', docs: 'https://cloud.baidu.com/doc/qianfan-api/s/3m9b5lqft' },
  ),
  hosted(
    'spark',
    'iFlytek Spark',
    'https://spark-api-open.xf-yun.com/v1',
    'SPARK_API_PASSWORD',
    'https://console.xfyun.cn/services/cbm',
    {
      modelsPath: null,
      freeTier: true,
      note: 'the key is the APIPassword of the model version you use (lite is free)',
    },
  ),
  hosted(
    'sensenova',
    'SenseNova',
    'https://token.sensenova.cn/v1',
    'SENSENOVA_API_KEY',
    'https://platform.sensenova.cn/console',
    { modelsPath: null, freeTier: true },
  ),
  hosted(
    'ollama-cloud',
    'Ollama Cloud',
    'https://ollama.com/v1',
    'OLLAMA_API_KEY',
    'https://ollama.com',
    { docs: 'https://docs.ollama.com/cloud' },
  ),
];

/** Data platforms whose URL holds an account or workspace. */
const PLATFORMS: readonly CatalogEntry[] = [
  hosted(
    'snowflake',
    'Snowflake Cortex',
    'https://{account}.snowflakecomputing.com/api/v2/cortex/v1',
    'SNOWFLAKE_PAT',
    'https://app.snowflake.com',
    {
      fields: [{ key: 'account', label: 'Account identifier', placeholder: 'myorg-myaccount' }],
      modelsPath: null,
      note: 'the key is a programmatic access token; the role needs CORTEX_USER',
      docs: 'https://docs.snowflake.com/en/user-guide/snowflake-cortex/open_ai_sdk',
    },
  ),
  hosted(
    'databricks',
    'Databricks Model Serving',
    'https://{workspace}/serving-endpoints',
    'DATABRICKS_TOKEN',
    'https://docs.databricks.com/aws/en/dev-tools/auth/pat',
    {
      fields: [
        {
          key: 'workspace',
          label: 'Workspace host',
          placeholder: 'dbc-1234abcd-5678.cloud.databricks.com',
        },
      ],
      keyPrefix: 'dapi',
      modelsPath: null,
      note: 'model names are serving endpoint names',
      docs: 'https://docs.databricks.com/aws/en/machine-learning/model-serving/query-chat-models',
    },
  ),
];

/** Hosted gateways that route one key to many providers. */
const GATEWAYS: readonly CatalogEntry[] = [
  hosted(
    'helicone',
    'Helicone AI Gateway',
    'https://ai-gateway.helicone.ai/v1',
    'HELICONE_API_KEY',
    'https://helicone.ai/signup',
    { docs: 'https://docs.helicone.ai' },
  ),
  hosted(
    'martian',
    'Martian',
    'https://api.withmartian.com/v1',
    'MARTIAN_API_KEY',
    'https://app.withmartian.com',
  ),
];

export const MORE_HOSTED: readonly CatalogEntry[] = [...HOSTS, ...PLATFORMS, ...GATEWAYS];

export const MORE_LOCAL: readonly CatalogEntry[] = [
  local(
    'koboldcpp',
    'KoboldCpp',
    'http://localhost:5001/v1',
    'https://github.com/LostRuins/koboldcpp',
  ),
  local(
    'textgen',
    'text-generation-webui',
    'http://localhost:5000/v1',
    'https://github.com/oobabooga/text-generation-webui/wiki/12-%E2%80%90-OpenAI-API',
  ),
  {
    ...local(
      'llamafile',
      'Llamafile',
      'http://localhost:8080/v1',
      'https://github.com/Mozilla-Ocho/llamafile',
    ),
    modelsPath: null,
  },
  local(
    'mlx-lm',
    'MLX-LM server',
    'http://localhost:8080/v1',
    'https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md',
  ),
  local(
    'aphrodite',
    'Aphrodite Engine',
    'http://localhost:2242/v1',
    'https://github.com/aphrodite-engine/aphrodite-engine',
  ),
  {
    ...local('sglang', 'SGLang', 'http://localhost:30000/v1', 'https://docs.sglang.io'),
    modelsPath: null,
  },
  local('xinference', 'Xinference', 'http://localhost:9997/v1', 'https://inference.readthedocs.io'),
  {
    ...local(
      'docker-model-runner',
      'Docker Model Runner',
      'http://localhost:12434/engines/v1',
      'https://docs.docker.com/ai/model-runner/api-reference/',
    ),
    note: 'turn on host-side TCP support in Docker Desktop first',
  },
  local(
    'lemonade',
    'Lemonade Server',
    'http://localhost:13305/api/v1',
    'https://lemonade-server.ai/docs/api/openai/',
  ),
  {
    ...local('gpt4all', 'GPT4All', 'http://localhost:4891/v1', 'https://docs.gpt4all.io'),
    note: 'enable the Local API Server in Settings → Application → Advanced',
  },
];
