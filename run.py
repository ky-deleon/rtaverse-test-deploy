import os
from app import create_app

app = create_app(env=os.getenv("FLASK_ENV"))

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
