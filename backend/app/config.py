from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gcs_bucket_name: str = "hudson-crane-assets"
    template_presentation_id: str = ""
    template_slide_id: str = "p"
    two_product_template_slide_id: str = "g3eac671c004_0_16"
    oauth_client_secrets_file: str = "client_secrets.json"
    google_application_credentials: str = "gcs_key.json"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


settings = Settings()
