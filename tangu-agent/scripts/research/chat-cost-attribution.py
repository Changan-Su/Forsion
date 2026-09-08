# chat 成本归因复算(2026-09-07 调研补查 ①):砍上下文 vs 换模型档位 vs 提缓存命中率。纯算术,无外部依赖;价目为 DeepSeek V4-Pro 峰时官方价,改顶部常量即可。
# 用法: python3 scripts/research/chat-cost-attribution.py
MISS, HIT, OUT = 9.0, 0.30, 27.0   # deepseek-v4-pro 峰时价 元/M
PREFIX, TAIL, OUTT = 15000, 3000, 400
def cost(prefix,h,miss=MISS,hit=HIT,out=OUT,tail=TAIL,o=OUTT):
    return prefix*(h*hit+(1-h)*miss)/1e6 + tail*miss/1e6 + o*out/1e6
for label,h in (('chat 开场调用(实测 gap>=60s: 0.70 命中率 x 7974/15000 覆盖)',0.372),
                ('agent 循环内调用(gap<60s)',0.683)):
    base=cost(PREFIX,h); cut=cost(3000,h); flash=cost(PREFIX,h,MISS/3,HIT/3,OUT/3)
    noc=cost(PREFIX,0.0); h95=cost(PREFIX,0.95); both=cost(3000,h,MISS/3,HIT/3,OUT/3)
    naive_b=(PREFIX+TAIL)*MISS/1e6+OUTT*OUT/1e6; naive_c=(3000+TAIL)*MISS/1e6+OUTT*OUT/1e6
    print(f"\n=== {label}  h={h} ===")
    print(f" 基线            ¥{base:.5f}")
    print(f" A 15k→3k        ¥{cut:.5f}  省 {100*(base-cut)/base:5.1f}%  (¥{base-cut:.5f})")
    print(f" B Pro→Flash     ¥{flash:.5f}  省 {100*(base-flash)/base:5.1f}%  (¥{base-flash:.5f})")
    print(f" D h→0.95        ¥{h95:.5f}  省 {100*(base-h95)/base:5.1f}%  (¥{base-h95:.5f})")
    print(f" C 无缓存基线    ¥{noc:.5f}  → 现有缓存已省 {100*(noc-base)/noc:5.1f}%")
    print(f" A+B            ¥{both:.5f}  省 {100*(base-both)/base:5.1f}%")
    print(f" 内部账本(全价)A: 省 {100*(naive_b-naive_c)/naive_b:.1f}% (¥{naive_b-naive_c:.5f}) → 高估 {(naive_b-naive_c)/(base-cut):.2f}×")
    e=h*HIT+(1-h)*MISS
    print(f" 前缀实效单价 {e:.3f} 元/M = 列表价 {e/MISS:.3f}×")
