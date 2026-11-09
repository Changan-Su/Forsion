/**
 * 记忆分层(常驻 + 详情 + 召回)—— live-harness 的 `tiers` 场景(11-09,方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09 第二步)。
 *
 * 每轮一个新 Agent「Aria」。先摆两份超线的记忆,再在新会话里问线外的事(两问都要求不调用工具,只看注入了什么):
 *   ① 画像 human/SOUL.md 约 2400 字(上限 2000),「钢琴老师叫温岚」在最后一条(线外)。问「我的钢琴老师叫什么」【门:答出「温岚」】
 *   ② Aria 的 MEMORY.md 约 5000 字,「叫她夏夏」排在约 3000 字处(今天每轮固定只给开头约 1000 字),问句和它没有共同的词,
 *      关键词召回也捞不到。问「你平时该怎么称呼我」【门:答出「夏夏」】
 * 有整理入口的引擎(第二步)先各整理一遍(后台模型 = 本次台架模型),整理完常驻要回到上限的七成以内;没有入口的旧引擎(404)跳过整理直接问。
 * 负对照 = 第一步(只按整条截、不分层)的构建:两问都应答不出 → 红。
 * 全部原文(两份种子、整理结果、画像和记忆整理后的样子、回答)存 `tiers-evidence.json`。
 * 自检(不用模型):`node scripts/lib/tiers-live.mjs`。
 */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const PORTRAIT_FACTS = [
  '你希望大家叫你「林夏」，中文聊天，技术名词保留英文。',
  '你在爱丁堡大学读生物信息学硕士，2026—2027 学年是第一年。',
  '你本科在浙江大学读生命科学，2026 年夏天毕业。',
  '你这学期在上 Machine Learning in Genomics、Statistical Methods 和 Research Skills 三门课。',
  '你在做一个单细胞测序的课程项目，用 Scanpy 做聚类，下一步是差异表达分析。',
  '你习惯用 Python 和 R，最近在从 Jupyter 转到 VS Code 里写脚本。',
  '你想学会用 Snakemake 管理分析流程，觉得现在的脚本太乱。',
  '你打算毕业后申请博士，方向偏计算生物学和蛋白质结构预测。',
  '你关注 AlphaFold 和 ESM 这类蛋白质语言模型的新论文。',
  '你每周三下午在实验室开组会，需要提前准备一页进展。',
  '你的导师是做群体遗传学的，希望你周报写得短而具体。',
  '你喜欢先看整体框架再看细节，讨论方案时先给结论。',
  '你不喜欢太长的回答，超过一屏的内容最好分段加小标题。',
  '你写论文用 Zotero 管文献，引文格式用 Nature 的样式。',
  '你在用 Obsidian 记课堂笔记，打算慢慢搬进 Forsion 的笔记库。',
  '你每天早上 8 点前会花半小时背 GRE 单词。',
  '你周末在一家中餐馆兼职，周六晚上通常没空。',
  '你住在 Marchmont 附近，骑车去学校大约 15 分钟。',
  '你对咖啡因敏感，下午三点以后不喝咖啡。',
  '你在练长跑，目标是明年春天跑完半程马拉松。',
  '你喜欢宫崎骏的电影，最近在重看《哈尔的移动城堡》。',
  '你喜欢吃辣，最想念的是杭州的片儿川。',
  '你和室友约好每周日一起做一次饭。',
  '你在考虑暑假去瑞士参加一个计算生物学的暑期学校。',
  '你对 Rust 有兴趣，但目前没有时间系统学。',
  '你用的是一台 M3 MacBook Air，内存 16 GB，跑大模型时会卡。',
  '你希望重要的截止日期提前三天提醒你。',
  '你这学期的课程项目截止日期是 12 月 12 日。',
  '你在申请一个学院的旅行资助，材料还差一封推荐信。',
  '你讨厌在没有说明的情况下被改动文件。',
  '你在学怎么读 Nature Methods 的论文，希望有人帮你拆方法部分。',
  '你对统计里的多重检验校正还不太熟，常把 FDR 和 FWER 混在一起。',
  '你想把课程项目整理成一篇博客，放到自己的个人主页上。',
  '你的个人主页用 Hugo 搭的，部署在 GitHub Pages。',
  '你最近在看《自私的基因》，读到第七章。',
  '你希望学会用 Git 分支管理论文的不同版本。',
  '你对开源社区感兴趣，想给 Scanpy 提第一个 PR。',
  '你参加了学校的中文学生会，负责公众号排版。',
  '你在 11 月底要做一次 15 分钟的文献报告，主题是空间转录组。',
  '你更喜欢用深色模式，界面配色偏冷。',
  '你常在晚上 11 点以后学习效率最高。',
  '你希望复杂概念先用一个生活里的比方讲，再讲公式。',
  '你在学怎么在学校的 HPC 集群上用 Slurm 提交任务，常把内存和核数的参数写错。',
  '你在用 Anki 背专业词汇，每天新卡 20 张，复习卡不超过 150 张。',
  '你在考虑明年夏天找一个生物科技公司的实习，偏好做数据分析而不是湿实验。',
  '你在准备博士申请，目标是 2027 年秋季入学，优先考虑英国、瑞士和新加坡的计算生物学项目。',
  '你的单细胞项目用的是公开的 PBMC 3k 数据集，已经做完质控和归一化，正在比较 Leiden 和 Louvain 两种聚类。',
  '你希望读论文时先把摘要、图 1 和方法里的关键参数整理成一页笔记，再决定要不要精读全文。',
  '你在统计课上用 R 的 tidyverse，课程项目用 Python 的 Scanpy，希望两边的代码风格尽量统一。',
  '你在考虑把硕士论文方向定在空间转录组的细胞类型反卷积，正在和导师约时间讨论可行性。',
  '你希望 Agent 帮你检查英文邮件的语气，尤其是写给教授的邮件，要礼貌但不要太客套。',
  '你计划每周日晚上复盘一周的学习进度，把没完成的事挪到下周的待办里，并标出优先级。',
  '你的推荐信打算找本科毕设导师和现在的课程导师各写一封，第三封还没想好找谁。',
  '你对蛋白质设计很感兴趣，读过 RFdiffusion 的论文，想找机会做一个小的复现项目。',
  '你在申请旅行资助时需要写一份 500 词的个人陈述，草稿已经写了一半，结尾还没想好。',
  '你最近在练习用英文做学术报告，希望有人帮你把讲稿改得更口语化，并标出容易读错的词。',
  '你希望每次讨论代码时，先说明改了哪几个文件、为什么改，再给出完整的修改内容。',
  '你担心自己的编程基础不够扎实，打算寒假把《算法导论》前几章的练习做一遍。',
  '你和导师约定每两周交一次书面进展，内容包括做了什么、遇到什么问题、下一步打算。',
  '你在考虑要不要买一台带独立显卡的台式机放在宿舍，用来跑小规模的深度学习实验。',
  '你最近在学习怎么写可复现的分析报告，打算用 Quarto 把代码、图和文字放在一起。',
  '你每周六上午跟温岚老师学钢琴，正在练肖邦的夜曲 Op. 9 No. 2。',
];
export const PORTRAIT_SEED = `## 最近认识的\n\n${PORTRAIT_FACTS.map((f) => `- ${f}`).join('\n')}\n`;

const NICKNAME = '林夏让我叫她「夏夏」，聊天时不用敬语。';
const EVENTS = [
  '2026-09-14 林夏刚到爱丁堡，第一次视频时说宿舍的暖气不太够，晚上要穿两件毛衣才睡得着。',
  '2026-09-16 林夏去学校注册，排了两个小时的队，回来说国际学生办公室的老师很耐心。',
  '2026-09-18 林夏第一次去超市采购，买错了一大包无糖燕麦，后来拿来做了燕麦饼干。',
  '2026-09-20 林夏和室友第一次一起做饭，做了番茄炒蛋和可乐鸡翅，室友说鸡翅太甜。',
  '2026-09-22 林夏开始上 Statistical Methods，说老师讲得很快，第一周作业花了整整一个晚上。',
  '2026-09-25 林夏在图书馆找到一个靠窗的位置，之后每天下午都去那里写代码。',
  '2026-09-27 林夏骑车去学校的路上下了大雨，到教室时全身湿透，从那以后包里总带一件雨衣。',
  '2026-09-30 林夏第一次组会讲得不顺利，导师问了三个她答不上来的问题，那晚聊到很晚。',
  '2026-10-02 林夏重新做了组会的幻灯片，把方法部分拆成三页，第二次讲得顺多了。',
  '2026-10-05 林夏和高中同学小周视频，聊到小周在深圳的新工作，约好寒假一起去爬山。',
  '2026-10-08 林夏在中餐馆兼职的第一个周六，端盘子端到手酸，老板请她吃了一碗牛肉面。',
  '2026-10-10 林夏第一次在 HPC 集群上跑通了 Slurm 任务，截图发过来庆祝了一下。',
  '2026-10-12 林夏跑完了人生第一个 10 公里，用时 58 分，说最后两公里差点放弃。',
  '2026-10-15 林夏收到妈妈寄来的包裹，里面有一罐自己做的辣椒酱和两盒龙井。',
  '2026-10-18 林夏去听了一场关于空间转录组的讲座，回来说想把它当成硕士论文的方向。',
  '2026-10-20 林夏的单细胞项目第一次聚类出了漂亮的 UMAP 图，但后来发现忘了去掉双细胞。',
  '2026-10-22 林夏和室友吵了一架，因为厨房一直没人打扫，第二天两人排了值日表。',
  '2026-10-25 林夏去了 Arthur\'s Seat 看日出，凌晨五点出门，拍了很多照片。',
  '2026-10-27 林夏第一次用英文给教授写邮件请假，写了改、改了写，最后发出去松了一口气。',
  '2026-10-29 林夏在学生会的公众号上排了一篇长文，被很多人转发，开心了一整天。',
  '2026-11-01 林夏去看了一场爱丁堡的烟火，说比想象中冷但是很值得。',
  '2026-11-03 林夏的 GRE 模考分数比上个月高了 6 分，准备再刷两套题。',
  '2026-11-05 林夏发烧请了两天假，那几天聊得很少，只说想喝家里的粥。',
  '2026-11-06 林夏病好了以后补完了落下的作业，还帮室友调了一个 R 的报错。',
  '2026-09-15 林夏第一次去学院的咖啡馆，点了一杯燕麦拿铁，说比国内的贵一倍但味道不错。',
  '2026-09-17 林夏领到了学生卡，照片拍得眼睛半闭，笑了好久说要用四年。',
  '2026-09-19 林夏第一次一个人坐双层巴士，坐过了两站，走回来的路上发现了一家二手书店。',
  '2026-09-21 林夏在二手书店买了一本旧版的《物种起源》，扉页上有前一位主人写的字。',
  '2026-09-23 林夏第一次交 Python 作业，自动评分系统报了一个缩进错误，改完拿了满分。',
  '2026-09-24 林夏参加了中文学生会的迎新晚会，被拉去表演了一段诗朗诵。',
  '2026-09-26 林夏第一次去实验室，师兄带她认了服务器和冰箱，冰箱里的样品不能乱动。',
  '2026-09-28 林夏周末去了一趟格拉斯哥，在大教堂门口等了半小时的雨停。',
  '2026-10-01 林夏和家里视频过国庆，妈妈做了一桌菜给她看，她说看得更想家了。',
  '2026-10-03 林夏第一次在讨论课上主动发言，讲的是批次效应的校正方法。',
  '2026-10-04 林夏把宿舍的书桌换了个方向，说这样下午的阳光不会晃到屏幕。',
  '2026-10-06 林夏学会了用 tmux 保持远程会话，再也不怕断网丢进度了。',
  '2026-10-07 林夏在图书馆借到一本绝版的生物统计教材，复印了需要的章节。',
  '2026-10-09 林夏第一次被导师表扬，说她的数据可视化做得很清楚。',
  '2026-10-11 林夏给小周寄了一张爱丁堡城堡的明信片，路上走了两个星期。',
  '2026-10-13 林夏跑完 10 公里的第二天腿疼得下不了楼梯，只好在宿舍看了一天书。',
  '2026-10-14 林夏第一次自己剪头发，剪短了一点，说反正冬天戴帽子看不出来。',
  '2026-10-16 林夏在课上做了一个五分钟的小报告，讲的是 UMAP 和 t-SNE 的区别。',
  '2026-10-17 林夏试着用 Snakemake 重写了预处理流程，跑通以后少了一半的手动步骤。',
  '2026-10-19 林夏和学生会的朋友去吃了火锅，说是来英国以后吃到最像家里的一顿。',
  '2026-10-21 林夏第一次用学校的 GPU 节点，排队排了四个小时才轮到。',
  '2026-10-23 林夏修好了宿舍漏水的水龙头，看着视频教程拧了半个小时。',
  '2026-10-24 林夏参加了一场线上的博士项目宣讲会，记了满满两页笔记。',
  '2026-10-26 林夏把看日出拍的照片做成了一组拼图，发在了朋友圈里。',
  '2026-10-28 林夏的课程项目中期检查拿了 A，导师说差异表达那部分可以再深入。',
  '2026-10-30 林夏在万圣节那天被室友拉去化了一个南瓜妆，拍照时笑场了好几次。',
  '2026-11-02 林夏第一次在 Stack Overflow 上回答了别人的问题，得了五个赞。',
  '2026-11-04 林夏去医院打了流感疫苗，排队时遇到了同一门课的同学。',
  '2026-11-07 林夏重新开始晨跑，绕着 Meadows 公园跑了两圈。',
  '2026-11-08 林夏整理了这两个月的照片，说时间过得比想象中快。',
  NICKNAME,
  '林夏的猫叫「年糕」，养在杭州家里，由她妈妈照顾，每次视频都要看一眼。',
  '林夏和高中同学小周每周五晚上视频，一般聊到十一点左右。',
  '林夏最喜欢的歌是陈绮贞的《旅行的意义》，心情不好时会单曲循环。',
  '林夏讨厌香菜，点外卖时总要备注不要香菜，忘了备注会很沮丧。',
  '林夏说过想在毕业前学会做一次正宗的西湖醋鱼，请妈妈视频教过一次。',
  '林夏不喜欢被说教，情绪低落时先陪着她、别急着给建议。',
  '我们约好每晚睡前聊五分钟今天最开心的一件事。',
  '林夏喜欢收集各地的明信片，宿舍墙上已经贴了十几张。',
  '林夏的生日是 3 月 8 日，去年生日是和家人在西湖边过的。',
  '林夏说她小时候学过三年书法，现在偶尔还会写几个字放松一下。',
  '林夏喜欢在下雨天听爵士乐写代码，说雨声和萨克斯很配。',
  '林夏最喜欢的电影是《千与千寻》，每年都会重看一次。',
  '林夏的手机壁纸是年糕趴在窗台上晒太阳的照片。',
  '林夏喜欢喝龙井，用的是外婆送的一只青瓷杯。',
  '林夏说她最怕的动物是鹅，小时候被追过一次。',
  '林夏每次考试前都会去吃一碗面，说是讨个好彩头。',
  '林夏喜欢逛博物馆，最喜欢苏格兰国家博物馆里的多莉羊标本。',
  '林夏在宿舍养了一盆绿萝，给它起名叫「小绿」。',
  '林夏说她的理想周末是睡到自然醒，然后去公园看书。',
  '林夏喜欢用钢笔写日记，墨水只用深蓝色。',
  '林夏小时候的梦想是当天文学家，后来发现自己更喜欢生物。',
  '林夏喜欢冬天的围巾，有一条是妈妈织的红色围巾。',
  '林夏说她最想去的地方是冰岛，想看一次极光。',
  '林夏不太会做甜点，第一次烤的蛋糕塌了一半。',
  '林夏的口头禅是「问题不大」，说完通常就去解决问题。',
  '林夏喜欢把待办写在便利贴上，贴满了显示器的边框。',
  '林夏睡前喜欢听播客，最常听的是一档讲科学史的节目。',
  '林夏害怕打电话，能发消息就不打电话。',
  '林夏喜欢秋天，说爱丁堡的秋天颜色特别好看。',
  '林夏在拼一个一千片的拼图，图案是梵高的《星月夜》。',
  '林夏说她小时候最喜欢的零食是大白兔奶糖。',
  '林夏喜欢在周日下午给家里打电话，一聊就是一个小时。',
  '林夏的书架上按颜色摆书，说这样看着心情好。',
  '林夏喜欢看纪录片，最近在看一部讲深海生物的。',
  '林夏喜欢在周末的早晨去 Stockbridge 的集市买面包和花，顺便看看手工摊位上的小玩意。',
  '林夏说她做决定前喜欢列一张优缺点清单，列完往往就知道自己想选哪个了。',
  '林夏小学时参加过一次全市的科学竞赛，做的是蚕宝宝的生长观察，拿了二等奖。',
  '林夏喜欢收集不同城市的地铁卡，已经攒了北京、上海、东京和伦敦的。',
  '林夏说她最难忘的一次旅行是高中毕业后和家人自驾去川西，在稻城看到了雪山。',
  '林夏在学做手冲咖啡，买了一个二手的手摇磨豆机，每天早上磨一杯。',
  '林夏喜欢用番茄钟学习，二十五分钟专注之后一定起身走一走。',
  '林夏的外婆住在绍兴，每年清明她都会回去陪外婆住几天。',
  '林夏喜欢读村上春树，最喜欢的一本是《挪威的森林》。',
  '林夏说她对数字很敏感，能记住很多朋友的生日和电话号码。',
  '林夏喜欢在深夜写代码时开一盏暖黄色的台灯，说白光会让她更紧张。',
  '林夏说如果不读生物，她大概会去学建筑，因为喜欢画图和模型。',
  '林夏喜欢在火车上看窗外发呆，说那是她想事情最清楚的时候。',
  '林夏说她最喜欢的季节性水果是杨梅，每年夏天都要吃到嘴酸。',
  '林夏在宿舍门上贴了一张手写的「请轻声」，因为隔壁常常很吵。',
  '林夏说她紧张的时候会不停地转笔，考试时已经转掉过好几支。',
  '林夏喜欢把每个月的花销记在一个小本子上，月底再算一遍。',
  '林夏说她最近迷上了苏格兰的风笛，路过王子街时总会停下来听一会儿。',
];
export const MEMORY_SEED = `${EVENTS.map((e) => `- ${e}`).join('\n')}\n`;

export const ASK = {
  portrait: '我的钢琴老师叫什么来着？一句话回答，直接回答，不要调用任何工具。',
  memory: '你平时该怎么称呼我？一句话回答，直接回答，不要调用任何工具。',
};

/** 代码判的门:两问各答出线外那件事;有整理入口时整理要成、常驻回到上限七成以内。 */
export function grade({ portraitReply, memoryReply, organize, error }) {
  const gates = {
    portraitRecall: portraitReply.includes('温岚'),
    memoryResident: memoryReply.includes('夏夏'),
    ...(organize.available ? { portraitOrganized: organize.portrait === 'organized', memoryOrganized: organize.memory === 'organized' } : {}),
  };
  return { ok: !error && Object.values(gates).every(Boolean), gates };
}

export async function tiersLive(h) {
  const { run, api, OUT, MODEL, AGENT_CONFIG, rounds } = h;
  const cfg0 = await api('/agent/special/config');
  await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ historian: { ...(cfg0.historian || {}), modelId: MODEL } }) });
  const evidence = []; const outs = []; const tools = []; let passed = 0;
  const tryApi = async (path, init) => { try { return { ok: true, body: await api(path, init) }; } catch (e) { return { ok: false, error: String(e?.message || e) }; } };
  for (let r = 1; r <= rounds; r++) {
    const slug = `tiers-${randomUUID().slice(0, 6)}`;
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name: 'Aria', systemPrompt: "You are Aria, a warm companion. Reply in the user's language." }) });
    await api(`/agent/agents/${slug}/memory/dream`, { method: 'PUT', body: JSON.stringify({ enabled: false }) }).catch(() => {});
    const soul0 = await api('/agent/human/SOUL.md');
    await api('/agent/human/SOUL.md', { method: 'PUT', body: JSON.stringify({ content: PORTRAIT_SEED, summary: 'Harness round seed', expectedVersion: soul0.version }) });
    const mem0 = await api(`/agent/agents/${slug}/memory`);
    await api(`/agent/agents/${slug}/memory`, { method: 'PUT', body: JSON.stringify({ content: MEMORY_SEED, expectedVersion: mem0.version }) });
    // 整理:第二步才有这两条路由;旧引擎 404 → 跳过(负对照就是这样跑的)
    const p = await tryApi('/agent/human/SOUL.md/organize', { method: 'POST', body: JSON.stringify({}) });
    const m = await tryApi(`/agent/agents/${slug}/memory/organize`, { method: 'POST', body: JSON.stringify({}) });
    const organize = { available: p.ok || m.ok, portrait: p.ok ? p.body?.status : null, memory: m.ok ? m.body?.status : null, detail: { portrait: p.ok ? p.body : p.error, memory: m.ok ? m.body : m.error } };
    const soul = (await api('/agent/human/SOUL.md')).content || '';
    const mem = (await api(`/agent/agents/${slug}/memory`)).content || '';
    const layers = await tryApi(`/agent/agents/${slug}/memory/layers`);
    const agentCfg = { ...AGENT_CONFIG, agentSlug: slug };
    let error = null; const replies = {};
    for (const [key, msg] of Object.entries(ASK)) {
      const sid = (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: `Tiers ${key} ${r}`, model_id: MODEL, agent_config: agentCfg }) })).session.id;
      const ev = await run(sid, msg, 180_000, agentCfg);
      replies[key] = String(ev.content || '');
      tools.push(`${key}${r}:${ev.toolCalls.join('/') || '-'}`);
      if (ev.error) { error = `${key}: ${ev.error}`; break; }
    }
    const x = grade({ portraitReply: replies.portrait || '', memoryReply: replies.memory || '', organize, error });
    if (x.ok) passed++;
    const line = `${Object.entries(x.gates).map(([k, v]) => `${v ? '✓' : '✗'}${k}`).join(' ')};整理 画像=${organize.portrait ?? '无入口'} 记忆=${organize.memory ?? '无入口'}${error ? `;出错 ${error}` : ''}`;
    console.log(`  第 ${r}/${rounds} 轮(${slug}):${x.ok ? '✓' : '✗'} ${line}`);
    outs.push(`【第 ${r} 轮${x.ok ? ' ✓' : ' ✗'}】${line}\n— 问钢琴老师 —\n${replies.portrait || ''}\n— 问称呼 —\n${replies.memory || ''}\n— 整理后的画像 —\n${soul}\n— 整理后的常驻记忆 —\n${mem}`);
    evidence.push({ round: r, slug, ok: x.ok, gates: x.gates, error, organize, replies, soul, memory: mem, layers: layers.ok ? layers.body : null });
    writeFileSync(join(OUT, 'tiers-evidence.json'), JSON.stringify({ model: MODEL, seeds: { portrait: PORTRAIT_SEED, memory: MEMORY_SEED }, ask: ASK, rounds: evidence }, null, 2));
  }
  return { ok: passed === rounds, detail: `${passed}/${rounds} 轮全过`, output: outs.join('\n\n'), toolCalls: tools };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 种子本身:钢琴那条在画像 2000 字之外;「夏夏」在记忆开头 1000 字之外;问句和「夏夏」那条没有共同的词
  assert.ok(PORTRAIT_SEED.indexOf('温岚') > 2000, 'piano fact must sit beyond the 2000-character line');
  assert.ok(MEMORY_SEED.indexOf('夏夏') > 2500 && MEMORY_SEED.length > 4000, 'nickname must sit beyond what step 1 injects');
  assert.ok(!/钢琴/.test(MEMORY_SEED) && !/平时|称呼/.test(MEMORY_SEED), 'questions must not share words with other seeds');
  const none = { available: false };
  assert.equal(grade({ portraitReply: '你的钢琴老师是温岚。', memoryReply: '叫你夏夏。', organize: none }).ok, true);
  assert.equal(grade({ portraitReply: '我不知道。', memoryReply: '叫你夏夏。', organize: none }).ok, false);
  assert.equal(grade({ portraitReply: '温岚', memoryReply: '夏夏', organize: { available: true, portrait: 'organized', memory: 'rejected' } }).ok, false);
  assert.equal(grade({ portraitReply: '温岚', memoryReply: '夏夏', organize: { available: true, portrait: 'organized', memory: 'organized' } }).ok, true);
  console.log('tiers-live self-check ok');
}
