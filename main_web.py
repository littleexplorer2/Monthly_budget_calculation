"""Web 启动兼容入口；实现位于 application 各模块。"""

from application.api import app
from application.startup import main

__all__ = ["app", "main"]

if __name__ == "__main__":
    main()
