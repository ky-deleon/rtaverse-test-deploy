import sys, os
# make sure the project root is on sys.path
project_home = os.path.dirname(os.path.abspath(__file__))
if project_home not in sys.path:
    sys.path.insert(0, project_home)

from app import create_app
application = create_app(env="prod")  # PA uses "application"
