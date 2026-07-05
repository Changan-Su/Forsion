---
name: Python 数据分析
description: 当需要用 Python/pandas 分析数据文件、做统计聚合或绘制图表时使用,提供标准代码模式与 run_python 使用规范。
version: 1.0.0
category: 数据分析
---

# Python 数据分析

## run_python 使用原则

- **一次写完整脚本,而非碎片化多轮**:把"读取→清洗→分析→输出"写成一个完整脚本一次执行。多轮小片段会浪费轮次且容易丢状态。
- 例外:首次接触未知数据时,允许先跑一个**小探查脚本**(只看 shape/dtypes/head),据此再写完整分析脚本,总共两轮。
- 脚本里所有结论性数字都要 `print` 出来,图表保存为文件并打印保存路径,不要依赖交互式显示。
- 出错时整体修复脚本重跑,不要打补丁式追加片段。

## 第一步:探查数据(不要盲写分析)

```python
import pandas as pd
df = pd.read_csv(path)  # 编码报错时依次试 encoding='utf-8-sig' / 'gbk'
print(df.shape)
print(df.dtypes)
print(df.head(10))
print(df.isna().sum())
print(df.describe(include='all').T)
```

确认列名、类型、缺失情况后,再写正式分析。

## 清洗标准模式

```python
# 列名规整
df.columns = df.columns.str.strip()
# 类型转换:失败置 NaN 而不是抛错,便于统计坏行
df['amount'] = pd.to_numeric(df['amount'], errors='coerce')
df['date'] = pd.to_datetime(df['date'], errors='coerce')
bad = df['amount'].isna().sum()
print(f'无法解析的 amount 行数: {bad}')   # 坏数据要报告,不能静默丢弃
# 去重与缺失处理(策略要在结论里说明)
df = df.drop_duplicates()
df = df.dropna(subset=['date'])           # 关键列缺失才删行
```

原则:每一步清洗丢弃了多少数据必须 print 报告;不擅自用均值填充等改变分布的操作,除非用户同意。

## 聚合分析标准模式

```python
# 分组聚合
g = (df.groupby('category')
       .agg(总额=('amount','sum'), 单数=('amount','count'), 均值=('amount','mean'))
       .sort_values('总额', ascending=False))
print(g.round(2))

# 时间序列:按月汇总
m = df.set_index('date').resample('MS')['amount'].sum()
print(m)

# 同比/环比
print(m.pct_change().round(4))

# 透视表
p = pd.pivot_table(df, index='region', columns='category',
                   values='amount', aggfunc='sum', fill_value=0)
```

## matplotlib 中文字体处理(必做)

中文标签直接绘图会变方框,先探测可用字体:

```python
import matplotlib
import matplotlib.pyplot as plt
from matplotlib import font_manager
# 按优先级找系统里存在的中文字体
for f in ['Noto Sans CJK SC','WenQuanYi Micro Hei','SimHei','PingFang SC','Microsoft YaHei']:
    if any(f in x.name for x in font_manager.fontManager.ttflist):
        matplotlib.rcParams['font.sans-serif'] = [f]
        break
matplotlib.rcParams['axes.unicode_minus'] = False  # 负号正常显示
```

若全都不存在,回退方案:图表用英文标签,结论文字里用中文解释。

绘图输出规范:

```python
fig, ax = plt.subplots(figsize=(10, 6), dpi=120)
g['总额'].plot(kind='bar', ax=ax)
ax.set_title('各品类销售总额')
ax.set_xlabel('品类'); ax.set_ylabel('金额(元)')
plt.tight_layout()
out = '/tmp/category_sales.png'
plt.savefig(out); plt.close()
print(f'图表已保存: {out}')
```

每张图必有:标题、轴标签(含单位)、tight_layout、保存后 close 防内存累积。

## 大文件分块处理

文件超过几百 MB 或读入即内存报错时:

```python
agg = {}
for chunk in pd.read_csv(path, chunksize=200_000, usecols=['category','amount']):
    s = chunk.groupby('category')['amount'].sum()
    for k, v in s.items():
        agg[k] = agg.get(k, 0) + v
result = pd.Series(agg).sort_values(ascending=False)
```

配套手段:`usecols` 只读需要的列、`dtype` 显式指定省内存、先用 run_bash 跑 `wc -l file.csv && head -3 file.csv` 了解规模和表头再决定策略。

## 结论输出规范

- 结论必须**由打印出的数字支撑**,引用具体数值("3 月环比下降 12.4%"),不说"明显上升"这类含糊话。
- 报告结构:数据概况(行数/时间范围/清洗丢弃量)→ 关键发现(按重要性排序,每条带数字)→ 图表文件路径 → 局限性(缺失数据、口径假设)。
- 对异常值/离群点要点名并给出可能解释,而不是默默忽略。
- 用户要的是答案不是代码:回复以结论为主,代码已执行的细节简述即可。
