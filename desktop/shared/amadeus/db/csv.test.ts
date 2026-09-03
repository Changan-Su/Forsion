import { describe, expect, it } from 'vitest'
import { csvField, toCsv, withBom } from './csv'

describe('csvField(RFC 4180 转义)', () => {
  it('普通串不加引号', () => {
    expect(csvField('abc')).toBe('abc')
    expect(csvField('')).toBe('')
    expect(csvField('1234.5')).toBe('1234.5')
  })
  it('含逗号 → 加引号', () => {
    expect(csvField('a,b')).toBe('"a,b"')
  })
  it('含引号 → 加引号且内部双写', () => {
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""')
    expect(csvField('"')).toBe('""""')
  })
  it('含换行(LF / CRLF)→ 加引号,换行原样留在字段里', () => {
    expect(csvField('a\nb')).toBe('"a\nb"')
    expect(csvField('a\r\nb')).toBe('"a\r\nb"')
  })
  it('前后空白 → 加引号(否则被工具吃掉,还可能暴露出后面的 =)', () => {
    expect(csvField(' a')).toBe('" a"')
    expect(csvField('a ')).toBe('"a "')
  })
  it('中文原样(不转码;编码问题交给 BOM)', () => {
    expect(csvField('张三')).toBe('张三')
    expect(csvField('张三、李四')).toBe('张三、李四')
    expect(csvField('客户,备注')).toBe('"客户,备注"')
  })
})

describe('csvField(公式注入防护)', () => {
  it('= @ 开头 → 前置单引号变文本', () => {
    expect(csvField('=1+1')).toBe("'=1+1")
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
  })
  it('=cmd|... 这类 DDE 载荷同样被钉住(不含逗号引号,不必再包引号)', () => {
    expect(csvField('=cmd|\' /C calc\'!A0')).toBe("'=cmd|' /C calc'!A0")
  })
  it('制表/回车开头 → 防护(前导空白被吃掉后会暴露 =)', () => {
    expect(csvField('\t=1+1')).toBe('"\'\t=1+1"')
    expect(csvField('\r=1+1')).toBe('"\'\r=1+1"')
  })
  it('⚠️ 负数/正数字面量**不**防护 —— 否则每个负数金额都变文本,财务表导出报废', () => {
    expect(csvField('-1234.50')).toBe('-1234.50')
    expect(csvField('-0.5')).toBe('-0.5')
    expect(csvField('+7')).toBe('+7')
    expect(csvField('-.5')).toBe('-.5')
  })
  it('+ - 后面不是数字 → 防护(-cmd / +危险载荷)', () => {
    expect(csvField('-cmd|x')).toBe("'-cmd|x")
    expect(csvField('+A1')).toBe("'+A1")
    expect(csvField('-')).toBe("'-")
  })
  it('带格式的数字串(千分位)含逗号 → 只加引号,不加单引号', () => {
    expect(csvField('¥1,234.00元')).toBe('"¥1,234.00元"')
    expect(csvField('-¥1,234.00元')).toBe('"-¥1,234.00元"') // 货币符号豁免:不加 '
  })
})

describe('toCsv', () => {
  it('CRLF 分行 + 末尾换行', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d\r\n')
  })
  it('空矩阵 → 空串(不产出一个孤零零的换行)', () => {
    expect(toCsv([])).toBe('')
  })
  it('只有表头也成立', () => {
    expect(toCsv([['客户', '金额']])).toBe('客户,金额\r\n')
  })
  it('整表:引号 / 逗号 / 换行 / 注入混排', () => {
    const csv = toCsv([
      ['客户', '备注', '金额'],
      ['张三', 'a,b', '-1234.50'],
      ['=1+1', 'he said "hi"', '¥1,234.00元'],
      ['李四', '第一行\n第二行', ''],
    ])
    expect(csv).toBe(
      '客户,备注,金额\r\n' +
      '张三,"a,b",-1234.50\r\n' +
      "'=1+1,\"he said \"\"hi\"\"\",\"¥1,234.00元\"\r\n" +
      '李四,"第一行\n第二行",\r\n',
    )
  })
})

describe('withBom', () => {
  it('前置 U+FEFF(Excel 中文不乱码);纯函数 toCsv 自己不带', () => {
    expect(withBom('a,b\r\n')).toBe('\uFEFFa,b\r\n')
    expect(toCsv([['a']]).startsWith('\uFEFF')).toBe(false)
  })
})
