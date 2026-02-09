import pandas as pd
import numpy as np

INPUT_CSV = "historical_11y_data.csv"
OUTPUT_CSV = "nifty250_log_return_volatility.csv"

print("Loading data...")
df = pd.read_csv(INPUT_CSV)

# Convert date
df['date'] = pd.to_datetime(df['date'], errors='coerce')

# Ensure numeric close
df['close'] = pd.to_numeric(df['close'], errors='coerce')

# Drop invalid rows
df = df.dropna(subset=['symbol', 'date', 'close'])

# Sort correctly (CRITICAL)
df = df.sort_values(['symbol', 'date'])

print("Calculating returns...")

# 1️⃣ Daily percentage return
df['daily_return'] = (
    df.groupby('symbol')['close']
      .pct_change()
)

# 2️⃣ Natural log return
df['log_return'] = np.log(
    df['close'] / df.groupby('symbol')['close'].shift(1)
)

print("Calculating 1-year rolling volatility (log returns)...")

# 3️⃣ 1-year volatility using LOG RETURNS (252 trading days)
df['volatility_1y'] = (
    df.groupby('symbol')['log_return']
      .rolling(window=252, min_periods=252)
      .std()
      .reset_index(level=0, drop=True)
)

print("Saving output...")
df.to_csv(OUTPUT_CSV, index=False)

print("Done ✅")
