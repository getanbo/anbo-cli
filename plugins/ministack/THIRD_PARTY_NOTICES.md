# Third-Party Runtime Notices

The MIT License in this repository covers the Anbo MiniStack plugin source. The plugin
also acquires or invokes separately distributed runtime components. Those
components are not relicensed by this project.

| Component | Certified version | License | How it is used |
| --- | --- | --- | --- |
| [MiniStack](https://github.com/ministackorg/ministack/tree/v1.4.2) | 1.4.2 | [MIT](https://github.com/ministackorg/ministack/blob/v1.4.2/LICENSE) | Docker image pulled at runtime. |
| [Terraform](https://github.com/hashicorp/terraform/tree/v1.15.7) | 1.15.7 | [Business Source License 1.1](https://github.com/hashicorp/terraform/blob/v1.15.7/LICENSE) | HashiCorp Docker worker pulled at runtime. Terraform 1.15.7 is source-available, not OSI-approved open source. |
| [Terraform AWS provider](https://github.com/hashicorp/terraform-provider-aws/tree/v6.54.0) | 6.54.0 in the acceptance fixture; project constraints may differ | [MPL-2.0](https://github.com/hashicorp/terraform-provider-aws/blob/v6.54.0/LICENSE) | Downloaded by Terraform at runtime. |

Container base images, project-selected Terraform modules/providers, adapters,
and application dependencies have their own terms. Review them before use or
redistribution. See the lock files and manifest in a consuming project for the
exact additional components that project selects.
