# Scanner provider setup

PokéCollector can scan cards with Google Gemini, hosted OpenAI, or a vision server that implements the OpenAI Chat Completions format. Changing the provider changes only the API connection. The scanner uses the same prompts, matching steps, queue, warnings, and retry countdown for every provider. Automatic visual verification remains enabled whenever the selected model proves that it can compare multiple images.

## Who configures what

- The administrator enables providers, sets their base URL, chooses which models are allowed, and decides whether users need an API key.
- Each user chooses from those approved providers and models in **Settings → AI / Card Scanner** and adds a personal API key only when required.
- Normal users cannot enter a base URL or arbitrary model name. This keeps the form simple and prevents accounts from directing the backend to unintended network services. Administrators can test a custom model under **Advanced model**. If it handles one image but cannot compare multiple images, only an administrator can explicitly acknowledge and save it in limited mode.

A **base URL** is the address PokéCollector sends scanner requests to. PokéCollector adds `/chat/completions` to it, so an OpenAI-compatible base URL normally ends in `/v1`, for example `https://api.openai.com/v1` or `http://ollama:11434/v1`.

## User setup

1. Open **Settings → AI / Card Scanner**.
2. Choose a provider if the administrator enabled more than one.
3. Choose a model if the administrator approved more than one.
4. If an API key is requested, use the **Get a key** link and paste the key. Keys are stored but are never displayed again.
5. Select **Test and save**. PokéCollector sends two tiny real images in one request to confirm multi-image input. Runtime visual verification may compare the source photo with several candidate references, so this is a small capability probe rather than an exact copy of a card scan. The complete configuration is saved atomically only after the test succeeds. Hosted providers may charge a very small amount for this request.

If the two-image comparison fails but a follow-up one-image test succeeds, an administrator is shown an unchecked acknowledgment. Accepting it saves that administrator's provider/model selection in limited mode with visual verification disabled. It does not enable limited mode for other user accounts. This is never selected silently. A warning remains visible in Scanner Settings and in the card scanner so users know to review similar card matches carefully.

Provider and model changes cannot bypass this test. If the provider is temporarily unavailable, the existing saved configuration remains unchanged and the user can try again later. Removing a configured API key remains possible without a provider request.

The status at the top explains what is still needed:

- **Ready**: the selected provider has the required user settings.
- **API key required**: add or replace the key for the selected provider.
- **Retest required**: the compatible endpoint changed since this model was tested. Test and save again before scanning.
- **Administrator setup required**: the server has no usable approved model for that provider.

## Administrator setup

Put the chosen variables in the project `.env` file, then recreate the backend:

```bash
docker compose up -d --build backend
```

Open Scanner Settings as an administrator afterward. The **Server setup details** section shows enabled providers, the sanitized destination, approved models, and whether each user needs a key. It never displays API keys.

If a compatible vision model is not in the approved list, expand **Advanced model**, enable **Use a custom model**, and enter its exact identifier. **Test and save** first verifies two-image input. If only the one-image fallback succeeds, the administrator may explicitly save limited mode. Custom models are available only to the administrator who tested them; normal users continue to receive the guarded administrator-approved dropdown.

Capability proof is bound to the selected provider, model, and configured endpoint. Changing `OPENAI_BASE_URL` invalidates the proof and blocks scanning until the configuration is tested again. PokéCollector stores a non-reversible endpoint fingerprint for this comparison rather than copying endpoint credentials into the setting. Rotating `JWT_SECRET_KEY` (or its persisted secret file) also changes that fingerprint and therefore requires a retest.

### Google Gemini

Gemini remains the default and needs no provider opt-in. Users can create a key in [Google AI Studio](https://aistudio.google.com/apikey).

```env
GEMINI_MODEL=gemini-flash-latest
# Optional additional choices, comma-separated:
GEMINI_ALLOWED_MODELS=gemini-flash-latest
```

`GEMINI_API_KEY` can bootstrap the administrator's key on a new installation, but other users still add their own key in Settings:

```env
GEMINI_API_KEY=replace_with_admin_key
```

Google's official key documentation is available in the [Gemini API key guide](https://ai.google.dev/gemini-api/docs/api-key).

### Hosted OpenAI

Users create their own key on the [OpenAI API keys page](https://platform.openai.com/api-keys). Enable the provider explicitly:

```env
OPENAI_SCANNER_ENABLED=true
OPENAI_PROVIDER_LABEL=OpenAI
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.6-luna
OPENAI_ALLOWED_MODELS=gpt-5.6-luna
OPENAI_API_KEY_REQUIRED=true
```

Only add models that accept image input through Chat Completions. Model availability and billing depend on the user's OpenAI account.

### Ollama on the Docker host

Install Ollama on the host and pull a vision-capable model. The [official Ollama OpenAI compatibility guide](https://docs.ollama.com/api/openai-compatibility) includes image requests and currently demonstrates `qwen3-vl:8b`:

```bash
ollama pull qwen3-vl:8b
```

Configure PokéCollector:

```env
OPENAI_SCANNER_ENABLED=true
OPENAI_PROVIDER_LABEL=Local Ollama
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_MODEL=qwen3-vl:8b
OPENAI_ALLOWED_MODELS=qwen3-vl:8b
OPENAI_API_KEY_REQUIRED=false
```

On Linux, Ollama normally listens only on `127.0.0.1`, which a Docker container cannot reach through `host.docker.internal`. Configure Ollama with `OLLAMA_HOST=0.0.0.0:11434`, restart it, and use the host firewall to restrict port `11434` to trusted networks. See the [Ollama FAQ](https://docs.ollama.com/faq#how-do-i-configure-ollama-server) for the operating-system-specific service configuration.

### Ollama as another Compose service

Add an Ollama service to the same Compose project (or use a Compose override):

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    volumes:
      - ollama_data:/root/.ollama

volumes:
  ollama_data:
```

Then use the Compose service name as the host:

```env
OPENAI_SCANNER_ENABLED=true
OPENAI_PROVIDER_LABEL=Local Ollama
OPENAI_BASE_URL=http://ollama:11434/v1
OPENAI_MODEL=qwen3-vl:8b
OPENAI_ALLOWED_MODELS=qwen3-vl:8b
OPENAI_API_KEY_REQUIRED=false
```

Pull the model once the service is running:

```bash
docker compose exec ollama ollama pull qwen3-vl:8b
```

The Ollama port does not need to be published to the host when only PokéCollector uses it on the Compose network.

### Other OpenAI-compatible providers

The same integration can work with llama.cpp, LM Studio, vLLM, or another hosted/local server when all of these are true:

- The server accepts `POST <base URL>/chat/completions`.
- The selected model supports image input.
- Images are accepted as `data:` URLs in `image_url` content blocks.
- The response uses the OpenAI Chat Completions `choices[].message.content` shape.
- The exact model identifier is present in `OPENAI_MODEL` or `OPENAI_ALLOWED_MODELS`, or an administrator tests it through **Advanced model**.
- Authentication accepts an optional `Authorization: Bearer <key>` header. Set `OPENAI_API_KEY_REQUIRED` accordingly.
- Rate limits should preferably use `Retry-After` (seconds or an HTTP date) or OpenAI-style `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens` headers.

Example:

```env
OPENAI_SCANNER_ENABLED=true
OPENAI_PROVIDER_LABEL=My Vision Server
OPENAI_BASE_URL=https://vision.example.com/v1
OPENAI_MODEL=vision-model-name
OPENAI_ALLOWED_MODELS=vision-model-name,vision-model-name-fast
OPENAI_API_KEY_REQUIRED=true
```

Do not add `/chat/completions` to `OPENAI_BASE_URL`; PokéCollector adds that path itself. Do not point the base URL at an untrusted server: it receives card photos, prompts, and any key users submit for that provider.

## Queue and error behavior

Provider-specific errors are translated into the same scanner states:

- A temporary rate limit uses the provider's reset time when available and shows the normal queue countdown.
- If no reliable reset time is supplied, the queue uses bounded increasing delays.
- Invalid keys, unavailable models, unsupported image requests, malformed requests, and exhausted billing quota stop immediately with an actionable message instead of retrying for days.
- A provider block is shared safely across scans using a non-reversible credential fingerprint, or the configured endpoint for a keyless server. PokéCollector does not repeatedly hit a provider that has already asked it to wait.

## Troubleshooting

| Message or symptom | What to check |
| --- | --- |
| API key required | Create a key using the link in Settings, paste it, test, and save. |
| API key rejected | Confirm the key belongs to the selected provider and is active. Replace it in Settings; the old value cannot be viewed. |
| Selected model is unavailable | Ask the administrator to correct the model name or allowlist and confirm that the model is installed/enabled upstream. |
| Administrator setup required | Check the environment variables and restart/recreate the backend. |
| Connection refused or timed out | Verify the base URL from inside the backend container. For a host Ollama service, check `host.docker.internal`, `OLLAMA_HOST`, and the firewall. |
| Limited scanner mode | The model passed one-image recognition but could not compare multiple images. Visual verification is disabled; review similar matches carefully, or switch to a multi-image-capable model. |
| Retest required after an endpoint change | `OPENAI_BASE_URL` no longer matches the endpoint used for the saved capability proof. Test and save the model again. |
| Rate limit countdown | Wait for the displayed time. PokéCollector resumes the queued scan automatically. |
| Daily quota or billing error | Check the provider account's quota and billing. Permanent billing exhaustion is not retried automatically. |

Use **Test** or **Test and save** in Scanner Settings for the real image-capability check. Avoid putting API keys in shell commands, URLs, screenshots, or issue reports.

## Privacy, costs, and backups

- Hosted providers receive the submitted card photos and prompts and may charge for both the initial recognition and automatic visual verification requests. Review that provider's privacy and retention terms.
- A local provider keeps model processing on the network at the configured base URL, but PokéCollector cannot guarantee the behavior of that external service.
- User API keys are stored in the PokéCollector database so queued scans can run later. They are never returned by the settings API or included in debug logs.
- Database backups can contain stored API keys. Protect backups like credentials, restrict access, and delete obsolete copies securely.
- At-rest application-level key encryption requires its own key-management and migration design. It is not enabled merely by selecting a different provider.
