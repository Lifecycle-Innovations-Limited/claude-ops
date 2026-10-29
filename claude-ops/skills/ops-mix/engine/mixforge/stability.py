"""Optionele, expliciet aangevraagde Stable Audio-adapter. API-contract onbevestigd."""

import http.client
import os
from pathlib import Path
import urllib.error
import urllib.request
import uuid

DEFAULT_ENDPOINT = "https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio"


def generate_bridge(prompt: str, seconds: float, destination: Path, *,
                    endpoint: str = DEFAULT_ENDPOINT, model: str | None = None,
                    max_seconds: float = 190, timeout: float = 120) -> str | None:
    key = (os.environ.get("STABILITY_API_KEY") or "").strip()
    if not key:
        return "STABILITY_API_KEY ontbreekt; overgang wordt zonder gegenereerd tussenstuk gerenderd."
    if not endpoint.startswith("https://api.stability.ai/"):
        raise ValueError("Stability-endpoint moet HTTPS op api.stability.ai gebruiken")
    boundary = uuid.uuid4().hex
    fields = {"prompt": prompt, "duration": str(min(seconds, max_seconds)), "output_format": "wav"}
    if model:
        fields["model"] = model
    body = b"".join((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode()
                    for name, value in fields.items()) + f"--{boundary}--\r\n".encode()
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Accept": "audio/wav",
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    # Redirects mogen de Authorization-header niet naar een andere host meenemen.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            audio = response.read(100 * 1024 * 1024 + 1)
        if len(audio) > 100 * 1024 * 1024 or not audio.startswith(b"RIFF"):
            return "Stability gaf geen ondersteund WAV-bestand; normale overgang gebruikt."
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(audio)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, http.client.HTTPException):
        return "Stability-aanvraag mislukt; normale overgang gebruikt. API-contract is onbevestigd."
    return None
