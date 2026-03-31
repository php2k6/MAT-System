FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
# Adding build-essential and libpq-dev helps if pip needs to compile any dependencies (like numpy C-extensions or custom fastAPI libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/backend/requirements.txt

# Copy the application
COPY backend/ /app/backend/

# Ensures modules like `from backend.models...` run correctly from the /app root
ENV PYTHONPATH=/app

EXPOSE 8000

# Gunicorn/Uvicorn entrypoint 
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
