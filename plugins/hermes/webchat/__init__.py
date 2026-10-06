"""WebChatMCP model provider for Hermes Agent.

Provider name: ``webchat``. Chats go through a running WebChatMCP.js server, which types each prompt into a
private/temporary chat of ChatGPT, Claude, Grok or Gemini and returns the answer text.

Hermes only registers an ``api_key`` profile that declares ``env_vars``. An explicitly selected provider
with no usable key fails immediately (``No usable credentials``) and does not walk the provider ladder.
``fallback_models`` is only the picker list when ``GET /models`` fails — it is not a credential fallback.
The install script therefore writes a dummy ``WEBCHAT_API_KEY`` (the bridge ignores it).

Models: ``chatgpt``, ``claude``, ``grok``, ``gemini`` (whatever is selected on that site) plus
``<service>/<label>`` entries cached by ``POST <server>/hermes/webchat/refresh``.

Limits: text only — no tool calls, no images, no token streaming (the whole answer arrives at once).
"""

from providers import register_provider
from providers.base import ProviderProfile

webchat = ProviderProfile(
    name="webchat",
    aliases=("webchatmcp", "web-chat"),
    display_name="WebChat (WebChatMCP)",
    description="ChatGPT / Claude / Grok / Gemini through their private web chats (WebChatMCP.js; text only)",
    env_vars=("WEBCHAT_API_KEY", "WEBCHAT_BASE_URL"),
    base_url="http://127.0.0.1:8321/hermes/v1",
    fallback_models=("chatgpt", "claude", "grok", "gemini"),
    default_aux_model="chatgpt",
)

register_provider(webchat)
