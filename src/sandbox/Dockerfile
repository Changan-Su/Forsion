# Tangu Agent run_python 沙箱镜像。
# 在 python:3.12-slim 上预装「离线文档/数据处理」常用库——因为运行时容器是 --network none，
# 无法 pip install，必须在 build 期装好。覆盖 docx/xlsx/pptx/pdf 生成 + 数据/绘图。
#
# 构建：  docker build -t forsion-agent-sandbox:py312 server/microserver/agent-core/sandbox
# 或：    npm run sandbox:build   (见 package.json)
FROM python:3.12-slim

# matplotlib / Pillow 的少量系统依赖（多数 wheel 自带，这里补字体与 libgomp 等）
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-dejavu-core libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      python-docx==1.1.2 \
      python-pptx==1.0.2 \
      openpyxl==3.1.5 \
      XlsxWriter==3.2.0 \
      pypdf==5.1.0 \
      pdfplumber==0.11.4 \
      reportlab==4.2.5 \
      pandas==2.2.3 \
      numpy==2.1.3 \
      matplotlib==3.9.2 \
      Pillow==11.0.0 \
      lxml==5.3.0 \
      markdown==3.7 \
      beautifulsoup4==4.12.3 \
      tabulate==0.9.0

# 预导入做一次字节码编译 + 校验，缩短首次执行耗时；任一失败则构建失败（早发现缺包）。
RUN python3 -c "import docx, pptx, openpyxl, xlsxwriter, pypdf, pdfplumber, reportlab, pandas, numpy, matplotlib, PIL, lxml, markdown, bs4, tabulate; print('sandbox libs OK')"
