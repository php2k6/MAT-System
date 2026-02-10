import pandas as pd
import numpy as np
import yfinance as yf
from datetime import timedelta

MASTER_CSV = "nifty250_log_return_volatility.csv"
TRADING_WINDOW = 252

# ---------- Load existing master ----------
print("Loading master CSV...")
df = pd.read_csv(MASTER_CSV)

df['date'] = pd.to_datetime(df['date'])
df['close'] = pd.to_numeric(df['close'], errors='coerce')

symbols = df['symbol'].unique()
today = pd.Timestamp.today().normalize()

new_rows = []

# ---------- Fetch only missing data ----------
for symbol in symbols:
    last_date = df.loc[df['symbol'] == symbol, 'date'].max()
    start_date = last_date + timedelta(days=1)

    if start_date > today:
        continue

    ticker = symbol + ".NS"
    data = yf.download(
        ticker,
        start=start_date,
        end=today,
        auto_adjust=False,
        progress=True
    )

    if data.empty:
        continue

    data = data.reset_index()
    data['symbol'] = symbol

    data = data.rename(columns={
        'Date': 'date',
        'Open': 'open',
        'High': 'high',
        'Low': 'low',
        'Close': 'close',
        'Volume': 'volume'
    })

    new_rows.append(data)

# ---------- Append new data ----------
if new_rows:
    df_new = pd.concat(new_rows, ignore_index=True)
    df = pd.concat([df, df_new], ignore_index=True)

# Remove accidental duplicates
df = df.drop_duplicates(subset=['symbol', 'date'], keep='last')

# ---------- Incremental indicator update ----------
print("Updating indicators incrementally...")

updated_chunks = []

for symbol in symbols:
    stock_df = df[df['symbol'] == symbol].sort_values('date')

    # Only last window + new rows
    tail_df = stock_df.tail(TRADING_WINDOW + 5).copy()

    tail_df['daily_return'] = tail_df['close'].pct_change()
    tail_df['log_return'] = np.log(
        tail_df['close'] / tail_df['close'].shift(1)
    )

    tail_df['volatility_1y'] = (
        tail_df['log_return']
        .rolling(TRADING_WINDOW, min_periods=TRADING_WINDOW)
        .std()
    )

    # Remove old tail and replace with updated one
    stock_df = stock_df.iloc[:-len(tail_df)]
    stock_df = pd.concat([stock_df, tail_df])

    updated_chunks.append(stock_df)

# ---------- Final save ----------
df_final = pd.concat(updated_chunks, ignore_index=True)

df_final.to_csv(MASTER_CSV, index=False)

print("Master CSV updated successfully ✅")
