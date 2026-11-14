"""子行程輸出解碼。

Windows 中文環境的 locale 是 cp936（GBK）。若用 subprocess.run(..., text=True)，
子行程只要吐出任何非 GBK 位元組（UTF-8 中文、emoji、二進位殘留），讀取執行緒就會拋
UnicodeDecodeError，結果是 stdout 直接變成 None——工具表面回 success，內容卻整段消失。

這裡改成一律先取 bytes，再按 utf-8 → gb18030 → utf-8(replace) 的順序降級解碼：
  - 純 ASCII / UTF-8 輸出：走第一條，完全正確。
  - 原生 cmd / git 的 GBK 輸出：utf-8 嚴格解碼失敗後走 gb18030，仍然正確。
  - 真的混編的二進位：最後一條保證不會拋例外，最多是替換字元。
"""

from __future__ import annotations

_FALLBACK_ENCODINGS = ("utf-8", "gb18030")


def decode_output(data: bytes | str | None) -> str:
    """把子行程輸出解成 str；永不拋例外。"""
    if data is None:
        return ""
    if isinstance(data, str):
        return data
    for encoding in _FALLBACK_ENCODINGS:
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")
