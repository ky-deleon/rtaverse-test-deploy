from flask import Flask
from .config import DevConfig, ProdConfig
from .routes.auth import auth_bp
from .routes.views import views_bp
from .routes.api import api_bp

def create_app(env: str | None = None) -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")

    # choose config
    if (env or "").lower() == "prod":
        app.config.from_object(ProdConfig)
    else:
        app.config.from_object(DevConfig)

    # blueprints
    app.register_blueprint(auth_bp)
    app.register_blueprint(views_bp)
    app.register_blueprint(api_bp, url_prefix="/api")

    # session key
    if not app.config.get("SECRET_KEY"):
        app.config["SECRET_KEY"] = "change-me"

    return app
