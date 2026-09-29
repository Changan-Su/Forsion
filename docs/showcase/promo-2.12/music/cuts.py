"""Study B (「第 2.12 话」) cut times in seconds; every score cue locks to these."""
CARDS = [0.06, 0.40, 0.72, 1.04]   # 人格 / 记忆 / 技能 / 进化
QUESTION = 1.34                     # 人类？ (white flash)
HUD = 1.78                          # NERV-style HUD (flash)
LINES = [1.86 + 0.2 * i for i in range(5)]  # terminal lines typing
MAGI = [2.30, 2.38, 2.46]           # three panels flip to 移交
WARN = 2.35                         # HUMAN CONFIRMATION REQUIRED blinking (6 Hz)
EPISODE = 3.40                      # EPISODE 2.12 card
TITLE = 3.78                        # 人类补完计划 title card (flash)
CUE_LEN = 6.5
