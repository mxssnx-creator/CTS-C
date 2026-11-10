"""Independent Freqtrade spot dry-run comparison, never the x02 executor."""
import talib.abstract as ta
from pandas import DataFrame
from freqtrade.strategy import IStrategy


class CTSResearchStrategy(IStrategy):
    INTERFACE_VERSION = 3
    can_short = False
    timeframe = "5m"
    process_only_new_candles = True
    startup_candle_count = 55
    minimal_roi = {"0": 0.01}
    stoploss = -0.02
    trailing_stop = True
    trailing_stop_positive = 0.005
    trailing_stop_positive_offset = 0.01
    trailing_only_offset_is_reached = True

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema_fast"] = ta.EMA(dataframe, timeperiod=5)
        dataframe["ema_slow"] = ta.EMA(dataframe, timeperiod=21)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        cross = (dataframe.ema_fast > dataframe.ema_slow) & (dataframe.ema_fast.shift() <= dataframe.ema_slow.shift())
        dataframe.loc[cross & (dataframe.volume > 0), ["enter_long", "enter_tag"]] = (1, "ema_cross")
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        cross = (dataframe.ema_fast < dataframe.ema_slow) & (dataframe.ema_fast.shift() >= dataframe.ema_slow.shift())
        dataframe.loc[cross & (dataframe.volume > 0), ["exit_long", "exit_tag"]] = (1, "ema_reverse")
        return dataframe
