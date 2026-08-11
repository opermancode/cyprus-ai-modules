# Installing Ollama (Llama) on an Ubuntu Production Server

How to install and run the self-hosted LLM server that powers the **Cyprus** AI
feature on the prod box. Everything below was validated on Ubuntu 22.04/24.04
(the same method was used on the dev VM).

---

## 1. Hardware requirements (prod server)

| Setup | Recommended model | Concurrency |
|---|---|---|
| 8 GB RAM, CPU only | `llama3.2:3b` or `qwen2.5:3b` | 1–2 users |
| 16 GB RAM, CPU only | `llama3.1:8b` or `qwen2.5:7b` | 2–4 users |
| NVIDIA GPU (8+ GB VRAM) | `llama3.1:8b` | 8+ users |

CPU-only 7–8B models take roughly 5–20s per short generation — acceptable for
Cyprus's "polish a description" flow. If response time matters, use a GPU box.

---

## 2. Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

That installs the `ollama` binary, creates a systemd service, and starts it.

Verify it is running and enabled to survive reboots:

```bash
systemctl status ollama --no-pager | head -10
systemctl is-enabled ollama    # expect: enabled
systemctl is-active ollama     # expect: active
```

Check the OpenAI-compatible API responds:

```bash
curl -s http://localhost:11434/v1/models
```

---

## 3. Pull the model

Cyprus talks to Ollama's OpenAI-compatible endpoint. Pull the model that
matches the backend's `LLM_MODEL` env var. For a plain CPU prod box:

```bash
ollama pull llama3.2:3b
# or
ollama pull llama3.1:8b
# or (the default used in CYPRUS_AI_SETUP.md)
ollama pull qwen2.5:7b
```

List installed models and test one directly:

```bash
ollama list

curl -s http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:3b",
    "messages": [{"role": "user", "content": "Say hello in one word"}],
    "stream": false
  }'
```

---

## 4. Configure the backend to use it

In `backend/.env` on the prod server:

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.2:3b
```

- Ollama on the **same** box as the app → `http://localhost:11434/v1`
- Ollama on a **separate** server → `http://<llm-host>:11434/v1` and make sure
  the app server can reach that host:port (firewall/security-group).

After changing `.env`, restart the backend. The model name in `LLM_MODEL` must
exactly match an entry in `ollama list`.

---

## 5. Security — do NOT expose Ollama publicly

Ollama has no auth built in. Anyone who can reach port 11434 can use your GPU
and run arbitrary models. On prod:

- **Same box as the app:** keep the default bind to `127.0.0.1` — do nothing.
- **Separate LLM server:** bind to a private interface or put a firewall rule
  allowing only the app server's IP. By default it binds to `127.0.0.1`, which
  is already safe — only open it up if you really need a remote server, and
  then restrict by IP:

  ```bash
  sudo ufw allow from <app-server-ip> to any port 11434 proto tcp
  ```

- Never publish port 11434 to the internet via a public IP / cloud
  security-group inbound rule.

---

## 6. Tuning for concurrency

Ollama processes requests one at a time by default. To allow multiple users to
hit Cyprus at once, raise parallelism:

```bash
sudo systemctl edit ollama
```

Add:

```ini
[Service]
Environment="OLLAMA_NUM_PARALLEL=4"
# keep models loaded in RAM between requests:
Environment="OLLAMA_KEEP_ALIVE=30m"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
systemctl status ollama --no-pager | head -5
```

**Caution:** each parallel slot roughly doubles peak RAM. On a CPU-only box
`OLLAMA_NUM_PARALLEL=1` (default) is safest; on 16 GB+ or a GPU, 2–4 is fine.
OOM on the LLM server will make Cyprus hang, so test after changing this.

---

## 7. NVIDIA GPU support (optional)

If the prod server has an NVIDIA GPU:

```bash
sudo apt update && sudo apt install -y nvidia-driver-535   # or cuda-drivers
# install nvidia container toolkit (required by Ollama's GPU path)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo systemctl restart ollama

nvidia-smi                      # confirm GPU visible
ollama run llama3.1:8b --verbose   # watch the token/s vs CPU
```

---

## 8. Operations / troubleshooting

- **View logs:**
  ```bash
  journalctl -u ollama -n 50 --no-pager
  ```
- **Restart / stop / start:**
  ```bash
  sudo systemctl restart ollama
  sudo systemctl stop ollama
  sudo systemctl start ollama
  ```
- **Update Ollama and models:**
  ```bash
  curl -fsSL https://ollama.com/install.sh | sh   # upgrades the binary
  ollama pull llama3.2:3b                          # refreshes the model
  ```
- **Model location:** models live in `/usr/share/ollama/.ollama/models` (the
  service runs as the `ollama` user). Keep that disk with ~10 GB free per 3–8B
  model.
- **Slow response:** check CPU (`htop`) and swap (`free -h`). If swapping, lower
  the model size or add RAM. Check `journalctl -u ollama` for OOM kills.
- **Cyprus returns 502 from the backend:** the backend cannot reach Ollama.
  Confirm `LLM_BASE_URL`, that Ollama is active, and that a firewall isn't
  blocking the port.

---

## 9. Quick prod checklist

- [ ] Ollama installed, service enabled + active
- [ ] Model pulled and `ollama list` shows it
- [ ] `LLM_BASE_URL` / `LLM_MODEL` set in backend `.env`, model name matches
- [ ] Port 11434 NOT reachable from the public internet
- [ ] `OLLAMA_NUM_PARALLEL` tuned to the box's RAM
- [ ] nginx `proxy_read_timeout` ≥ 120s (see CYPRUS_AI_SETUP.md §6.3)
- [ ] Smoke test: login via the API, call `/api/ai/cyprus/refine`, watch the
      two "Version 1:" / "Version 2:" lines stream back
