FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
EXPOSE 8788
# Bind Railway's injected $PORT (fall back to 8788 locally); a hardcoded port
# fails Railway's edge healthcheck. Same shape as simple-kyc/kyc-proxy.
#
# One worker on purpose: the faucet holds a single key, so a second process
# would race the nonce. Scale by raising the caps, not the worker count.
CMD ["sh", "-c", "uvicorn faucet:app --host 0.0.0.0 --port ${PORT:-8788} --workers 1"]
