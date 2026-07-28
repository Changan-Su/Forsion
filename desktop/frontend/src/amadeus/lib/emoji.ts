// 页面图标用的 emoji 库 + 搜索。此前是硬编码在 amadeusViews 里的 66 个字符,选择器只能"看图找",
// 输入框仅支持粘贴。
//
// 为什么不装 emoji-mart / unicode-emoji-json:那些包连数据带皮肤色/多语言注解有几百 KB~几 MB,
// 而这里要的只是「一个能搜的图标网格」。渲染层三端共享(desktop/web/mobile),本地一张表零外部解析,
// 与 components/icons.tsx 同一条路子。想要全量 Unicode 的用户仍可在输入框直接粘贴任意字符。
//
// 每条 = [emoji, 关键词]。关键词空格分隔、中英混排(拼音只给最常搜的几个),小写匹配。

export interface EmojiGroup {
  name: string
  items: Array<[string, string]>
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: '常用',
    items: [
      ['📄', '文档 页面 文件 doc page file'], ['📝', '备忘 笔记 memo note write 写'],
      ['📌', '图钉 置顶 pin'], ['⭐', '星 收藏 star favorite'], ['✅', '完成 勾 对 check done'],
      ['🔥', '火 热门 fire hot'], ['💡', '灯泡 想法 点子 idea bulb'], ['🎯', '靶 目标 target goal'],
      ['🚀', '火箭 发布 上线 rocket launch'], ['🐞', '瓢虫 bug 缺陷 debug'],
      ['📅', '日历 日程 calendar date'], ['🧠', '大脑 思考 brain think'],
      ['🔒', '锁 加密 私密 lock private'], ['🔑', '钥匙 密钥 key'], ['📊', '图表 统计 chart data'],
      ['💰', '钱 预算 money budget'], ['⚙️', '齿轮 设置 配置 gear settings config'],
      ['📚', '书 资料 books library'], ['🏠', '房子 首页 home house'], ['❤️', '心 喜欢 爱 heart love'],
    ],
  },
  {
    name: '表情',
    items: [
      ['😀', '笑 开心 grin happy'], ['😃', '笑 开心 smile'], ['😄', '大笑 laugh'], ['😁', '龇牙 beam'],
      ['😆', '大笑 眯眼 laughing'], ['😅', '苦笑 汗 sweat smile'], ['🤣', '笑翻 rofl'],
      ['😂', '笑哭 joy tears'], ['🙂', '微笑 slight smile'], ['🙃', '倒脸 upside down'],
      ['😉', '眨眼 wink'], ['😊', '害羞 blush'], ['😇', '天使 innocent halo'],
      ['🥰', '爱心眼 love'], ['😍', '花痴 heart eyes'], ['🤩', '星星眼 star struck'],
      ['😘', '飞吻 kiss'], ['😗', '亲 kissing'], ['🤗', '拥抱 hug'], ['🤔', '思考 thinking'],
      ['🤨', '挑眉 raised eyebrow'], ['😐', '面无表情 neutral'], ['😑', '无语 expressionless'],
      ['🙄', '白眼 roll eyes'], ['😏', '得意 smirk'], ['😣', '难受 persevere'],
      ['😥', '失望 sad'], ['😮', '惊讶 open mouth'], ['🤐', '闭嘴 zipper'], ['😴', '睡觉 sleep zzz'],
      ['😌', '放松 relieved'], ['😛', '吐舌 tongue'], ['🤤', '流口水 drool'], ['😒', '不爽 unamused'],
      ['😓', '流汗 downcast sweat'], ['😔', '沮丧 pensive'], ['🙁', '不开心 frown'],
      ['😕', '困惑 confused'], ['😟', '担心 worried'], ['😢', '哭 cry'], ['😭', '大哭 sob'],
      ['😤', '生气 哼 triumph'], ['😠', '生气 angry'], ['😡', '愤怒 rage'], ['🤯', '爆炸 震惊 mind blown'],
      ['😳', '脸红 flushed'], ['🥵', '热 hot face'], ['🥶', '冷 cold face'], ['😱', '尖叫 scream'],
      ['😨', '害怕 fearful'], ['😰', '冷汗 anxious'], ['🤠', '牛仔 cowboy'], ['🥳', '庆祝 party face'],
      ['😎', '墨镜 酷 sunglasses cool'], ['🤓', '书呆 nerd'], ['🧐', '单片镜 monocle'],
      ['😷', '口罩 mask'], ['🤒', '发烧 sick'], ['🤢', '恶心 nauseated'], ['🥱', '打哈欠 yawn'],
      ['😬', '尴尬 grimace'], ['🤫', '嘘 安静 shush quiet'], ['🤥', '说谎 lying'],
      ['👻', '幽灵 ghost'], ['💀', '骷髅 skull'], ['👽', '外星人 alien'], ['🤖', '机器人 robot ai'],
      ['🎃', '南瓜 万圣节 halloween'], ['😺', '猫笑 cat'], ['🙈', '不看 see no evil'],
    ],
  },
  {
    name: '手势人物',
    items: [
      ['👍', '赞 好 thumbs up'], ['👎', '踩 差 thumbs down'], ['👌', 'ok 好 okay'],
      ['✌️', '胜利 victory peace'], ['🤞', '祈祷 交叉手指 fingers crossed'], ['🤝', '握手 合作 handshake'],
      ['👏', '鼓掌 clap'], ['🙌', '举手 庆祝 raising hands'], ['🙏', '拜托 感谢 pray thanks'],
      ['👋', '挥手 你好 wave hello'], ['✋', '手掌 停 hand stop'], ['👆', '向上 point up'],
      ['👇', '向下 point down'], ['👈', '向左 point left'], ['👉', '向右 point right'],
      ['✍️', '写字 writing'], ['💪', '肌肉 加油 muscle strong'], ['🦾', '机械臂 mechanical arm'],
      ['👀', '眼睛 看 eyes look'], ['🧑', '人 person'], ['👤', '用户 剪影 user profile'],
      ['👥', '多人 团队 users team'], ['👶', '婴儿 baby'], ['🧒', '小孩 child'],
      ['👨‍💻', '程序员 开发 developer coder'], ['👩‍💻', '程序员 开发 developer coder'],
      ['🧑‍🏫', '老师 teacher'], ['🧑‍🎓', '学生 毕业 student graduate'], ['🧑‍🍳', '厨师 chef'],
      ['🧑‍🔬', '科学家 scientist'], ['🧑‍⚕️', '医生 doctor'], ['🕵️', '侦探 调查 detective'],
      ['🦸', '超人 英雄 hero'], ['🧙', '法师 巫师 wizard'], ['🧘', '冥想 打坐 meditate yoga'],
      ['🏃', '跑步 run'], ['🚶', '走路 walk'], ['💃', '跳舞 dance'], ['👪', '家庭 family'],
      ['🤦', '扶额 无语 facepalm'], ['🤷', '耸肩 shrug'], ['🫡', '敬礼 salute'],
    ],
  },
  {
    name: '动物自然',
    items: [
      ['🐶', '狗 dog'], ['🐱', '猫 cat'], ['🐭', '鼠 mouse'], ['🐹', '仓鼠 hamster'],
      ['🐰', '兔 rabbit'], ['🦊', '狐狸 fox'], ['🐻', '熊 bear'], ['🐼', '熊猫 panda'],
      ['🐨', '考拉 koala'], ['🐯', '虎 tiger'], ['🦁', '狮 lion'], ['🐮', '牛 cow'],
      ['🐷', '猪 pig'], ['🐸', '青蛙 frog'], ['🐵', '猴 monkey'], ['🐔', '鸡 chicken'],
      ['🐧', '企鹅 penguin'], ['🐦', '鸟 bird'], ['🦆', '鸭 duck'], ['🦉', '猫头鹰 owl'],
      ['🦋', '蝴蝶 butterfly'], ['🐝', '蜜蜂 bee'], ['🐢', '乌龟 turtle'], ['🐍', '蛇 snake'],
      ['🐙', '章鱼 octopus'], ['🐳', '鲸 whale'], ['🐬', '海豚 dolphin'], ['🐟', '鱼 fish'],
      ['🦈', '鲨鱼 shark'], ['🦀', '螃蟹 crab'], ['🐴', '马 horse'], ['🦄', '独角兽 unicorn'],
      ['🐘', '大象 elephant'], ['🐺', '狼 wolf'], ['🦅', '鹰 eagle'], ['🐳', '鲸鱼 whale'],
      ['🌲', '树 松树 tree pine'], ['🌳', '树 tree'], ['🌵', '仙人掌 cactus'], ['🌴', '棕榈 palm'],
      ['🍀', '四叶草 幸运 clover luck'], ['🌿', '草叶 herb'], ['🍃', '叶子 leaf'],
      ['🌸', '樱花 blossom sakura'], ['🌺', '花 hibiscus'], ['🌻', '向日葵 sunflower'],
      ['🌹', '玫瑰 rose'], ['🌷', '郁金香 tulip'], ['🌼', '雏菊 daisy'],
      ['🌊', '海浪 水 wave ocean'], ['☀️', '太阳 晴 sun sunny'], ['🌙', '月亮 夜 moon night'],
      ['⭐', '星 star'], ['🌟', '闪星 sparkle star'], ['⚡', '闪电 快 lightning fast'],
      ['🔥', '火 fire'], ['❄️', '雪花 冷 snow cold'], ['🌈', '彩虹 rainbow'],
      ['☁️', '云 cloud'], ['🌧️', '雨 rain'], ['⛰️', '山 mountain'], ['🌍', '地球 世界 earth world'],
    ],
  },
  {
    name: '食物',
    items: [
      ['🍎', '苹果 apple'], ['🍊', '橙子 orange'], ['🍋', '柠檬 lemon'], ['🍌', '香蕉 banana'],
      ['🍉', '西瓜 watermelon'], ['🍇', '葡萄 grapes'], ['🍓', '草莓 strawberry'],
      ['🫐', '蓝莓 blueberry'], ['🍑', '桃 peach'], ['🥭', '芒果 mango'], ['🍍', '菠萝 pineapple'],
      ['🥥', '椰子 coconut'], ['🥑', '牛油果 avocado'], ['🍅', '番茄 tomato'],
      ['🥕', '胡萝卜 carrot'], ['🌽', '玉米 corn'], ['🥔', '土豆 potato'], ['🍞', '面包 bread'],
      ['🥐', '可颂 croissant'], ['🥯', '贝果 bagel'], ['🧀', '奶酪 cheese'], ['🥚', '蛋 egg'],
      ['🍳', '煎蛋 早餐 cooking breakfast'], ['🥞', '松饼 pancake'], ['🥓', '培根 bacon'],
      ['🍔', '汉堡 burger'], ['🍟', '薯条 fries'], ['🍕', '披萨 pizza'], ['🌭', '热狗 hotdog'],
      ['🌮', '塔可 taco'], ['🍜', '拉面 面 noodles ramen'], ['🍚', '米饭 rice'],
      ['🍱', '便当 bento'], ['🍣', '寿司 sushi'], ['🍤', '虾 shrimp'], ['🥟', '饺子 dumpling'],
      ['🍲', '炖菜 火锅 stew hotpot'], ['🥗', '沙拉 salad'], ['🍿', '爆米花 popcorn'],
      ['🍰', '蛋糕 cake'], ['🎂', '生日蛋糕 birthday'], ['🍪', '饼干 cookie'],
      ['🍫', '巧克力 chocolate'], ['🍬', '糖 candy'], ['🍦', '冰淇淋 ice cream'],
      ['☕', '咖啡 coffee'], ['🍵', '茶 tea'], ['🧋', '奶茶 bubble tea'], ['🍺', '啤酒 beer'],
      ['🍷', '红酒 wine'], ['🥂', '干杯 庆祝 cheers'], ['💧', '水 滴 water drop'],
    ],
  },
  {
    name: '活动旅行',
    items: [
      ['⚽', '足球 soccer'], ['🏀', '篮球 basketball'], ['🏈', '橄榄球 football'],
      ['⚾', '棒球 baseball'], ['🎾', '网球 tennis'], ['🏐', '排球 volleyball'],
      ['🏓', '乒乓 ping pong'], ['🏸', '羽毛球 badminton'], ['🥊', '拳击 boxing'],
      ['🏊', '游泳 swim'], ['🚴', '骑车 cycling'], ['⛷️', '滑雪 ski'], ['🏔️', '雪山 mountain'],
      ['🎣', '钓鱼 fishing'], ['🎮', '游戏 game'], ['🕹️', '街机 arcade'], ['🎲', '骰子 dice'],
      ['♟️', '棋 chess'], ['🎨', '画画 艺术 art paint'], ['🎭', '戏剧 theater'],
      ['🎵', '音乐 music'], ['🎸', '吉他 guitar'], ['🎹', '钢琴 piano'], ['🎤', '麦克风 唱歌 mic sing'],
      ['🎧', '耳机 headphone'], ['🎬', '电影 拍摄 movie film'], ['📷', '相机 拍照 camera photo'],
      ['🎥', '摄像 video'], ['🏆', '奖杯 冠军 trophy win'], ['🥇', '金牌 first medal'],
      ['🎁', '礼物 gift'], ['🎉', '庆祝 party'], ['🎊', '彩带 confetti'], ['🎈', '气球 balloon'],
      ['✈️', '飞机 出行 plane travel'], ['🚗', '汽车 car'], ['🚕', '出租 taxi'],
      ['🚌', '公交 bus'], ['🚇', '地铁 metro subway'], ['🚄', '高铁 火车 train'],
      ['🚢', '船 ship'], ['🚲', '自行车 bike'], ['🛵', '摩托 scooter'], ['🗺️', '地图 map'],
      ['🧭', '指南针 方向 compass'], ['🏝️', '海岛 island'], ['🏖️', '海滩 beach'],
      ['🏕️', '露营 camping'], ['🗼', '塔 tower'], ['🏛️', '建筑 古典 classical building'],
      ['🏢', '办公楼 office'], ['🏫', '学校 school'], ['🏥', '医院 hospital'],
      ['🏦', '银行 bank'], ['⛩️', '神社 shrine'], ['🗿', '石像 moai'],
    ],
  },
  {
    name: '物品',
    items: [
      ['💻', '电脑 笔记本 laptop computer'], ['🖥️', '台式机 显示器 desktop monitor'],
      ['⌨️', '键盘 keyboard'], ['🖱️', '鼠标 mouse'], ['📱', '手机 phone mobile'],
      ['💾', '软盘 保存 save floppy'], ['💿', '光盘 disc'], ['🗄️', '文件柜 归档 archive cabinet'],
      ['🗂️', '分类 索引 folder index'], ['📁', '文件夹 folder'], ['📂', '打开文件夹 open folder'],
      ['📎', '回形针 附件 clip attach'], ['📏', '尺子 ruler'], ['✂️', '剪刀 剪 scissors cut'],
      ['🖊️', '笔 pen'], ['✏️', '铅笔 编辑 pencil edit'], ['🖍️', '蜡笔 crayon'],
      ['🔍', '搜索 放大镜 search find'], ['🔎', '搜索 search'], ['🔬', '显微镜 研究 microscope'],
      ['🔭', '望远镜 探索 telescope'], ['🧪', '试管 实验 test experiment'],
      ['🧬', '基因 dna'], ['💊', '药 medicine pill'], ['🩺', '听诊器 医疗 stethoscope'],
      ['🔧', '扳手 修 wrench fix'], ['🔨', '锤子 hammer build'], ['🪛', '螺丝刀 screwdriver'],
      ['🧰', '工具箱 toolbox'], ['🧲', '磁铁 magnet'], ['🔋', '电池 battery'],
      ['🔌', '插头 电源 plug power'], ['💡', '灯泡 light idea'], ['🕯️', '蜡烛 candle'],
      ['📦', '包裹 打包 package box'], ['🛒', '购物车 cart shopping'], ['💳', '信用卡 支付 card pay'],
      ['🧾', '收据 账单 receipt bill'], ['💵', '钞票 现金 cash'], ['📈', '上涨 增长 chart up growth'],
      ['📉', '下跌 chart down'], ['📊', '柱状图 统计 bar chart stats'], ['🗒️', '记事本 notepad'],
      ['📋', '剪贴板 待办 clipboard todo'], ['📇', '名片 卡片 card index'],
      ['📖', '书 阅读 book read'], ['📰', '报纸 新闻 news'], ['✉️', '信 邮件 mail'],
      ['📧', '邮件 email'], ['📨', '收件 inbox'], ['📮', '邮筒 postbox'],
      ['🔔', '铃铛 提醒 bell notify'], ['📢', '喇叭 公告 announce'], ['🎙️', '播客 麦克风 podcast'],
      ['⏰', '闹钟 提醒 alarm'], ['⏳', '沙漏 等待 hourglass wait'], ['⌛', '计时 timer'],
      ['🗓️', '日程表 calendar schedule'], ['🖼️', '图片 相框 image picture'],
      ['🧩', '拼图 模块 puzzle module'], ['⚗️', '蒸馏 化学 alembic'],
      ['🛠️', '工具 维护 tools maintain'], ['🔗', '链接 link'], ['📡', '卫星 信号 satellite signal'],
    ],
  },
  {
    name: '符号',
    items: [
      ['✅', '完成 对勾 check done'], ['☑️', '勾选框 checkbox'], ['❌', '错 删除 cross wrong'],
      ['❗', '感叹号 重要 important'], ['❓', '问号 疑问 question'], ['⚠️', '警告 warning'],
      ['🚫', '禁止 forbidden'], ['🔴', '红点 red'], ['🟠', '橙 orange'], ['🟡', '黄 yellow'],
      ['🟢', '绿 green'], ['🔵', '蓝 blue'], ['🟣', '紫 purple'], ['⚫', '黑 black'],
      ['⚪', '白 white'], ['🟥', '红方块 red square'], ['🟩', '绿方块 green square'],
      ['🟦', '蓝方块 blue square'], ['🔶', '橙菱形 diamond'], ['🔺', '上三角 triangle up'],
      ['🔻', '下三角 triangle down'], ['➡️', '右箭头 arrow right'], ['⬅️', '左箭头 arrow left'],
      ['⬆️', '上箭头 arrow up'], ['⬇️', '下箭头 arrow down'], ['🔄', '循环 刷新 refresh loop'],
      ['🔀', '随机 shuffle'], ['▶️', '播放 play'], ['⏸️', '暂停 pause'], ['⏹️', '停止 stop'],
      ['♻️', '回收 循环 recycle'], ['💯', '满分 一百 hundred perfect'],
      ['💬', '对话 评论 comment chat'], ['🗨️', '发言 speech'], ['💭', '想法 气泡 thought'],
      ['♾️', '无限 infinity'], ['〰️', '波浪 wave'], ['✳️', '星号 asterisk'],
      ['🔆', '亮度 bright'], ['🆕', '新 new'], ['🆗', 'ok 好'], ['🔝', '置顶 top'],
      ['🈁', '这里 here'], ['㊗️', '祝 congrat'], ['💤', '睡 zzz'],
    ],
  },
]

/** 平铺的全部 emoji(随机取图标用)。 */
export const EMOJI_ALL: string[] = EMOJI_GROUPS.flatMap((g) => g.items.map(([e]) => e))

/**
 * 关键词搜索。空查询 → null(调用方展示分组网格)。
 * 命中规则:关键词以查询**开头**优先(打 "cat" 先出猫),其次包含;顺序稳定 = 组内原序。
 */
export function searchEmoji(query: string): string[] | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const starts: string[] = []
  const has: string[] = []
  const seen = new Set<string>()
  for (const g of EMOJI_GROUPS) {
    for (const [e, kw] of g.items) {
      if (seen.has(e)) continue
      const words = kw.split(/\s+/)
      if (words.some((w) => w.startsWith(q))) { starts.push(e); seen.add(e) }
      else if (kw.includes(q)) { has.push(e); seen.add(e) }
    }
  }
  return [...starts, ...has]
}
