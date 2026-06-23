# Instagram bridge sidecar: a small Python service driving a personal IG account via instagrapi.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Session + device fingerprint persist on a mounted volume, owned by a non-root user.
RUN useradd --create-home app && mkdir -p /data && chown -R app /data /app
USER app
VOLUME /data
EXPOSE 8099

CMD ["python", "app.py"]
